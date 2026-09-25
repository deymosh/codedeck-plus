//! `codedeck-bridge` — run agent sessions on this machine and drive them
//! from a phone.

use std::path::PathBuf;
use std::process::ExitCode;

use bridge_core::store_keys as io_keys;
use bridge_core::settings::StoredProfiles;
use bridge_core::PairedPhone;
use bridge_runtime::config::{self, Config, Flags};
use bridge_runtime::runtime::{self, Mode, Options, Outcome};
use bridge_runtime::state::{acquire_lock, lock_holder, StateFile};
use bridge_runtime::workspace::FsWorkspace;
use clap::{Parser, Subcommand};
use protocol::capabilities::PROTOCOL_VERSION;

#[derive(Parser)]
#[command(
    name = "codedeck-bridge",
    version,
    about = "Run agent sessions on this machine and drive them from the CodeDeck phone app.",
    after_help = "Configuration: flags > CODEDECK_* environment > <home>/config.json > defaults.\n\
                  State: <home>/state.json (bridge key and pairings, owner-only)."
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    /// State and config directory [env: CODEDECK_HOME] [default: ~/.codedeck]
    #[arg(long, global = true)]
    home: Option<PathBuf>,
    /// Name shown on the phone [env: CODEDECK_MACHINE_NAME]
    #[arg(long, global = true)]
    machine_name: Option<String>,
    /// Relay URL, repeatable [env: CODEDECK_RELAYS, comma-separated]
    #[arg(long = "relay", global = true)]
    relays: Vec<String>,
    /// Workspace root sessions may run in, repeatable [env: CODEDECK_WORKSPACE_ROOTS] [default: cwd]
    #[arg(long = "workspace", global = true)]
    workspaces: Vec<PathBuf>,
    /// Path to the claude executable [env: CODEDECK_CLAUDE_PATH]
    #[arg(long, global = true)]
    claude_path: Option<String>,
    /// SOCKS5 proxy for relay connections, e.g. socks5h://127.0.0.1:9050 [env: CODEDECK_TOR_PROXY_URL]
    #[arg(long, global = true)]
    tor_proxy: Option<String>,
    /// External OpenCode server [env: CODEDECK_OPENCODE_SERVER_URL]
    #[arg(long, global = true)]
    opencode_server_url: Option<String>,
    /// Start and manage an OpenCode server [env: CODEDECK_OPENCODE_AUTO_START]
    #[arg(long, global = true)]
    opencode_auto_start: bool,
    /// Path to the opencode executable, for auto-start [env: CODEDECK_OPENCODE_PATH]
    #[arg(long, global = true)]
    opencode_path: Option<String>,
    /// Path to the agent host bundle (main.js) [env: CODEDECK_AGENT_HOST]
    #[arg(long, global = true)]
    agent_host: Option<PathBuf>,
    /// Advertise as a service (auto-detected under systemd)
    #[arg(long, global = true)]
    service: bool,
    /// Agents answer canned test commands instead of running for real (no API key needed) [env: CODEDECK_TEST_MODE]
    #[arg(long, global = true)]
    test_mode: bool,
}

#[derive(Subcommand)]
enum Command {
    /// Run the bridge (default); opens a pairing window while no phone is paired
    Run,
    /// Show a pairing QR and wait for a phone to pair
    Pair,
    /// Show configuration, identity, paired phones and whether a bridge runs
    Status,
    /// Remove a paired phone (by npub, hex pubkey or label), or all of them
    Unpair {
        target: Option<String>,
        #[arg(long)]
        all: bool,
    },
    /// List the project folders a phone can start sessions in
    Folders,
    /// Print the version
    Version,
}

fn main() -> ExitCode {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info,rustls=warn,hyper=warn,hyper_util=warn,reqwest=warn,tungstenite=warn,tokio_tungstenite=warn"),
    )
    .init();
    let cli = Cli::parse();
    let flags = Flags {
        home: cli.home.clone(),
        machine_name: cli.machine_name.clone(),
        relays: cli.relays.clone(),
        workspaces: cli.workspaces.clone(),
        claude_path: cli.claude_path.clone(),
        tor_proxy: cli.tor_proxy.clone(),
        opencode_server_url: cli.opencode_server_url.clone(),
        opencode_auto_start: cli.opencode_auto_start,
        opencode_path: cli.opencode_path.clone(),
        agent_host: cli.agent_host.clone(),
        service: cli.service,
        test_mode: cli.test_mode,
    };
    let command = cli.command.unwrap_or(Command::Run);
    if let Command::Version = command {
        println!("codedeck-bridge {} (protocol v{PROTOCOL_VERSION})", bridge_runtime::version());
        return ExitCode::SUCCESS;
    }
    let config = match config::load(&flags) {
        Ok(c) => c,
        Err(err) => return fail(&err),
    };
    let result = match command {
        Command::Run => serve(config, Mode::Run),
        Command::Pair => serve(config, Mode::Pair),
        Command::Status => status(&config),
        Command::Unpair { target, all } => unpair(&config, target, all),
        Command::Folders => {
            let folders = FsWorkspace::new(config.workspace_roots.clone()).all_folders();
            if folders.is_empty() {
                println!("No project folders under {}", roots(&config));
            } else {
                println!("{}", folders.join("\n"));
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Version => unreachable!(),
    };
    result.unwrap_or_else(|err| fail(&err))
}

fn fail(err: &str) -> ExitCode {
    eprintln!("error: {err}");
    ExitCode::FAILURE
}

fn roots(config: &Config) -> String {
    config.workspace_roots.iter().map(|r| r.display().to_string()).collect::<Vec<_>>().join(", ")
}

fn paired(state: &StateFile) -> Vec<PairedPhone> {
    state.get(io_keys::PAIRED_PHONES).and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

/// Stored provider profiles, as the operator may see them: never a token.
fn profile_lines(state: &StateFile) -> Vec<String> {
    let stored: StoredProfiles =
        state.get(io_keys::PROVIDER_PROFILES).and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default();
    stored
        .profiles
        .iter()
        .map(|p| {
            format!(
                "    - {} \"{}\" {} ({} model(s), token {})",
                p.id,
                p.label,
                p.base_url,
                p.models.len(),
                if p.auth_token.is_some() { "yes" } else { "no" }
            )
        })
        .collect()
}

fn serve(config: Config, mode: Mode) -> Result<ExitCode, String> {
    let _lock = acquire_lock(&config.home)?;
    let state = StateFile::open(&config.home)?;
    let keys = state.identity()?;
    if !config.agent_host_path.exists() {
        return Err(format!(
            "the agent host bundle is missing at {} (set CODEDECK_AGENT_HOST or --agent-host)",
            config.agent_host_path.display()
        ));
    }
    println!(
        "codedeck-bridge {}{}\n  machine:    {} (host: {})\n  npub:       {}\n  relays:     {}{}\n  workspaces: {}\n  paired:     {} phone(s)",
        bridge_runtime::version(),
        if config.test_mode { " — TEST MODE (agents answer canned test commands)" } else { "" },
        config.machine,
        config.host_kind.as_wire(),
        keys.npub,
        config.relays.join(", "),
        if config.tor_proxy.is_some() { " (via Tor)" } else { "" },
        roots(&config),
        paired(&state).len(),
    );
    let tokio = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    let local = tokio::task::LocalSet::new();
    let options = Options::new(mode);
    let outcome = local.block_on(&tokio, runtime::run(config, state, keys, options))?;
    Ok(match outcome {
        Outcome::Stopped | Outcome::Paired => ExitCode::SUCCESS,
        Outcome::PairingFailed => ExitCode::FAILURE,
    })
}

fn status(config: &Config) -> Result<ExitCode, String> {
    let state = StateFile::open(&config.home)?;
    let identity = if state.has_identity() { state.identity()?.npub } else { "not created yet (created on first run/pair)".into() };
    let phones = paired(&state);
    let holder = lock_holder(&config.home);
    let mut lines = vec![
        "codedeck-bridge status".to_string(),
        format!("  home:       {}", config.home.display()),
        format!(
            "  config:     {}{}",
            config.config_file.display(),
            if config.config_file_exists { "" } else { " (not found — using defaults)" }
        ),
        format!("  machine:    {} (host: {})", config.machine, config.host_kind.as_wire()),
        format!("  identity:   {identity}"),
        format!("  relays:     {}{}", config.relays.join(", "), if config.tor_proxy.is_some() { " (via Tor)" } else { "" }),
        format!("  workspaces: {}", roots(config)),
        format!(
            "  agent host: {}{}",
            config.agent_host_path.display(),
            if config.agent_host_path.exists() { "" } else { " (MISSING)" }
        ),
        format!("  bridge:     {}", holder.map_or("not running".into(), |pid| format!("running (pid {pid})"))),
        format!("  paired:     {} phone(s)", phones.len()),
    ];
    lines.extend(phones.iter().map(|p| format!("    - {} {} (paired {})", p.label, p.npub, p.paired_at)));
    let profiles = profile_lines(&state);
    if !profiles.is_empty() {
        lines.push(format!("  providers:  {} custom profile(s)", profiles.len()));
        lines.extend(profiles);
    }
    println!("{}", lines.join("\n"));
    Ok(ExitCode::SUCCESS)
}

fn unpair(config: &Config, target: Option<String>, all: bool) -> Result<ExitCode, String> {
    if let Some(pid) = lock_holder(&config.home) {
        return Err(format!("a bridge is running (pid {pid}) and owns the state file. Stop it first, then unpair."));
    }
    if !all && target.is_none() {
        return Err("usage: codedeck-bridge unpair <npub|pubkey-hex|label> | --all".into());
    }
    let state = StateFile::open(&config.home)?;
    let phones = paired(&state);
    if phones.is_empty() {
        return Err("no phones are paired".into());
    }
    let keep: Vec<PairedPhone> = if all {
        Vec::new()
    } else {
        let t = target.as_deref().unwrap_or_default();
        phones.iter().filter(|p| p.npub != t && p.pubkey_hex != t && p.label != t).cloned().collect()
    };
    if keep.len() == phones.len() {
        let list: Vec<String> = phones.iter().map(|p| format!("  - {} {}", p.label, p.npub)).collect();
        return Err(format!("no paired phone matches \"{}\". Paired:\n{}", target.unwrap_or_default(), list.join("\n")));
    }
    state.set(io_keys::PAIRED_PHONES, &serde_json::to_string(&keep).expect("phones serialize"))?;
    println!("Unpaired {} phone(s). {} remaining.", phones.len() - keep.len(), keep.len());
    Ok(ExitCode::SUCCESS)
}
