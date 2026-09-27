package com.codedeck.plus.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.codedeck.plus.core.CoreHost
import com.codedeck.plus.ui.components.Field
import com.codedeck.plus.ui.components.Group
import com.codedeck.plus.ui.components.GroupBody
import com.codedeck.plus.ui.components.GroupScope
import com.codedeck.plus.ui.components.Page
import com.codedeck.plus.ui.components.QuietButton
import com.codedeck.plus.ui.components.SecondaryButton
import com.codedeck.plus.ui.components.machineLabel
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.launch
import uniffi.client_ffi.UniffiAgentPlugins
import uniffi.client_ffi.UniffiAvailablePlugin
import uniffi.client_ffi.UniffiInstalledPlugin
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiMachineSummary
import uniffi.client_ffi.UniffiPluginFailure
import uniffi.client_ffi.UniffiPluginMarketplace

/** The marketplace Claude Code's own plugins come from, offered when none is known yet. */
internal const val OFFICIAL_MARKETPLACE = "anthropics/claude-plugins-official"

private enum class PluginsTab { Installed, Browse }

/** What a failed change was, in words: "install commit-commands@…". */
internal fun failureLine(f: UniffiPluginFailure): String {
    val verb = when (f.action) {
        "add-marketplace" -> "add the marketplace"
        "remove-marketplace" -> "remove the marketplace"
        "update-marketplace" -> "update the marketplace"
        else -> f.action
    }
    return "Could not $verb ${f.target}: ${f.error}"
}

/** The offer matching [query] (name or description, case aside), most
 *  installed first. */
internal fun browseResults(available: List<UniffiAvailablePlugin>, query: String): List<UniffiAvailablePlugin> {
    val q = query.trim().lowercase()
    return available
        .filter { q.isEmpty() || it.name.lowercase().contains(q) || it.description?.lowercase()?.contains(q) == true }
        .sortedWith(compareByDescending<UniffiAvailablePlugin> { it.installCount ?: 0uL }.thenBy { it.name })
}

/**
 * One agent's plugins on a machine. An agent with marketplaces (Claude Code)
 * gets two views — what is installed, with its marketplaces, and the catalog
 * to install from; one without (OpenCode) installs by package name. Pure —
 * the caller supplies the machine and a dispatcher — so it renders the same
 * in a snapshot.
 */
@Composable
fun PluginsContent(
    machine: UniffiMachineSummary,
    agentId: String,
    dispatch: (UniffiIntent) -> Unit,
    onBack: () -> Unit,
    startOnBrowse: Boolean = false,
) {
    val agent = machine.agents.firstOrNull { it.id == agentId }
    val plugins = machine.plugins.firstOrNull { it.agent == agentId }
    var tab by remember(machine.pubkeyHex, agentId) { mutableStateOf(if (startOnBrowse) PluginsTab.Browse else PluginsTab.Installed) }
    val marketplaceCount = plugins?.marketplaces?.size ?: 0

    // The installed list on opening; the catalog each time it is shown, and
    // again when a marketplace comes or goes.
    LaunchedEffect(machine.pubkeyHex, agentId) {
        dispatch(UniffiIntent.RequestPlugins(machine.pubkeyHex, agentId, available = false))
    }
    LaunchedEffect(machine.pubkeyHex, agentId, tab, marketplaceCount) {
        if (tab == PluginsTab.Browse) dispatch(UniffiIntent.RequestPlugins(machine.pubkeyHex, agentId, available = true))
    }
    fun act(action: String, target: String) = dispatch(UniffiIntent.PluginAction(machine.pubkeyHex, agentId, action, target))

    var confirm by remember { mutableStateOf<Pair<String, String>?>(null) }

    Page(title = "${agent?.displayName ?: agentId} plugins", subtitle = machineLabel(machine.name), onBack = onBack) {
        if (plugins?.marketplaces != null) TabSwitch(tab, installedCount = plugins.installed.size) { tab = it }
        plugins?.failure?.let { ErrorLine(failureLine(it)) }
        when {
            plugins == null -> Note("Asking the machine…")
            plugins.error != null && plugins.installed.isEmpty() && plugins.marketplaces.isNullOrEmpty() -> ErrorLine(plugins.error!!)
            tab == PluginsTab.Browse -> BrowseView(plugins, ::act)
            else -> InstalledView(plugins, ::act, onBrowse = { tab = PluginsTab.Browse }, onConfirm = { confirm = it })
        }
    }

    confirm?.let { (action, target) ->
        val removing = action == "uninstall"
        AlertDialog(
            onDismissRequest = { confirm = null },
            containerColor = Tokens.SurfaceRaised,
            title = { Text(if (removing) "Uninstall $target?" else "Remove the marketplace $target?", color = Tokens.Text) },
            text = {
                Text(
                    if (removing) "Sessions on this machine stop loading it." else "Plugins installed from it stay until you uninstall them.",
                    color = Tokens.TextMuted,
                )
            },
            confirmButton = {
                QuietButton(if (removing) "Uninstall" else "Remove", danger = true, onClick = {
                    act(action, target)
                    confirm = null
                })
            },
            dismissButton = { QuietButton("Cancel", onClick = { confirm = null }) },
        )
    }
}

@Composable
private fun TabSwitch(tab: PluginsTab, installedCount: Int?, onSelect: (PluginsTab) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Tokens.RadiusPill))
            .background(Tokens.SurfaceRaised)
            .padding(4.dp),
    ) {
        PluginsTab.entries.forEach { t ->
            val selected = t == tab
            val label = if (t == PluginsTab.Installed && installedCount != null) "Installed ($installedCount)" else t.name
            Text(
                label,
                color = if (selected) Tokens.AccentContrast else Tokens.TextMuted,
                fontSize = Tokens.TextMd,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(Tokens.RadiusPill))
                    .background(if (selected) Tokens.Accent else Tokens.SurfaceRaised)
                    .clickable { onSelect(t) }
                    .padding(vertical = 10.dp),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
        }
    }
}

@Composable
private fun InstalledView(
    plugins: UniffiAgentPlugins,
    act: (String, String) -> Unit,
    onBrowse: () -> Unit,
    onConfirm: (Pair<String, String>) -> Unit,
) {
    val marketplaces = plugins.marketplaces
    if (plugins.installed.isEmpty()) {
        Group {
            GroupBody {
                Text("No plugins installed", color = Tokens.Text, fontSize = Tokens.TextLg)
                Text(
                    if (marketplaces != null) "Plugins add commands, skills, agents and hooks to every session on this machine."
                    else "Plugins are npm packages that extend every session on this machine.",
                    color = Tokens.TextMuted,
                    fontSize = Tokens.TextSm,
                )
                if (!marketplaces.isNullOrEmpty()) SecondaryButton("Browse plugins", onBrowse)
            }
        }
    } else {
        // Without marketplaces there are no tabs to say what this list is.
        Group(title = if (marketplaces == null) "Installed" else null) {
            plugins.installed.forEachIndexed { i, p ->
                if (i > 0) Divider()
                InstalledRow(p, busy = p.id in plugins.busy, toggles = plugins.toggles, act = act, onUninstall = { onConfirm("uninstall" to p.id) })
            }
        }
    }
    if (marketplaces == null) {
        PackageInstall(plugins, act)
    } else {
        Marketplaces(marketplaces, plugins.busy, act, onRemove = { onConfirm("remove-marketplace" to it) })
    }
}

@Composable
private fun InstalledRow(p: UniffiInstalledPlugin, busy: Boolean, toggles: Boolean, act: (String, String) -> Unit, onUninstall: () -> Unit) {
    var open by remember(p.id) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().clickable { open = !open }.padding(horizontal = Tokens.Space4, vertical = 10.dp)) {
        Row(Modifier.heightIn(min = 36.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    p.name,
                    color = if (p.enabled) Tokens.Text else Tokens.TextMuted,
                    fontSize = Tokens.TextLg,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                p.description?.let {
                    Text(it, color = Tokens.TextMuted, fontSize = Tokens.TextSm, maxLines = if (open) 6 else 1, overflow = TextOverflow.Ellipsis)
                }
            }
            when {
                busy -> Spinner()
                toggles -> Switch(
                    checked = p.enabled,
                    onCheckedChange = { on -> act(if (on) "enable" else "disable", p.id) },
                    colors = SwitchDefaults.colors(
                        checkedThumbColor = Tokens.AccentContrast,
                        checkedTrackColor = Tokens.Accent,
                        uncheckedThumbColor = Tokens.TextMuted,
                        uncheckedTrackColor = Tokens.SurfaceInput,
                        uncheckedBorderColor = Tokens.BorderStrong,
                    ),
                )
            }
        }
        if (open) {
            val origin = listOfNotNull(p.marketplace?.let { "From $it" }, p.version?.let { "version ${it.take(12)}" })
            if (origin.isNotEmpty()) Text(origin.joinToString(", "), color = Tokens.TextDim, fontSize = Tokens.TextXs, modifier = Modifier.padding(top = 4.dp))
            Row(Modifier.padding(top = 2.dp)) { QuietButton("Uninstall", onClick = onUninstall, danger = true, enabled = !busy) }
        }
    }
}

@Composable
private fun Marketplaces(marketplaces: List<UniffiPluginMarketplace>, busy: List<String>, act: (String, String) -> Unit, onRemove: (String) -> Unit) {
    var source by remember { mutableStateOf("") }
    Group(
        title = "Marketplaces",
        footer = "A marketplace is a git repository listing plugins — yours too. Add one by owner/repo or its URL.",
    ) {
        marketplaces.forEachIndexed { i, m ->
            if (i > 0) Divider()
            MarketplaceRow(m, busy = m.name in busy, onUpdate = { act("update-marketplace", m.name) }, onRemove = { onRemove(m.name) })
        }
        if (marketplaces.isNotEmpty()) Divider()
        GroupBody {
            if (marketplaces.isEmpty()) {
                Text("No marketplace yet. Claude Code's own is the usual start.", color = Tokens.TextMuted, fontSize = Tokens.TextSm)
                SecondaryButton(
                    if (OFFICIAL_MARKETPLACE in busy) "Adding…" else "Add the official marketplace",
                    onClick = { act("add-marketplace", OFFICIAL_MARKETPLACE) },
                    enabled = OFFICIAL_MARKETPLACE !in busy,
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                Field(source, { source = it }, Modifier.weight(1f), placeholder = "owner/repo or URL", mono = true)
                val adding = source.trim() in busy
                SecondaryButton(if (adding) "Adding…" else "Add", onClick = {
                    act("add-marketplace", source.trim())
                    source = ""
                }, enabled = source.isNotBlank() && !adding)
            }
        }
    }
}

/** A marketplace: its name and where it comes from; a tap offers updating
 *  or removing it. */
@Composable
private fun MarketplaceRow(m: UniffiPluginMarketplace, busy: Boolean, onUpdate: () -> Unit, onRemove: () -> Unit) {
    var open by remember(m.name) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().clickable { open = !open }.padding(horizontal = Tokens.Space4, vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(m.name, color = Tokens.Text, fontSize = Tokens.TextLg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(m.source, color = Tokens.TextMuted, fontSize = Tokens.TextSm, maxLines = if (open) 3 else 1, overflow = TextOverflow.Ellipsis)
            }
            if (busy) Spinner()
        }
        if (open) {
            Row(Modifier.padding(top = 2.dp)) {
                QuietButton("Update", onClick = onUpdate, enabled = !busy)
                QuietButton("Remove", onClick = onRemove, danger = true, enabled = !busy)
            }
        }
    }
}

@Composable
private fun PackageInstall(plugins: UniffiAgentPlugins, act: (String, String) -> Unit) {
    var name by remember { mutableStateOf("") }
    Group(
        title = "Install a plugin",
        footer = "It is installed from npm the next time OpenCode loads. Changing its plugins reloads OpenCode, which restarts its running sessions.",
    ) {
        GroupBody {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                Field(name, { name = it }, Modifier.weight(1f), placeholder = "npm package name", mono = true)
                val installing = name.trim() in plugins.busy
                SecondaryButton(if (installing) "Installing…" else "Install", onClick = {
                    act("install", name.trim())
                    name = ""
                }, enabled = name.isNotBlank() && !installing)
            }
        }
    }
}

@Composable
private fun BrowseView(plugins: UniffiAgentPlugins, act: (String, String) -> Unit) {
    var query by remember { mutableStateOf("") }
    val available = plugins.available
    if (plugins.marketplaces.isNullOrEmpty()) {
        Note("Add a marketplace to browse its plugins.")
        return
    }
    if (available == null) {
        Note("Reading the marketplaces…")
        return
    }
    Field(query, { query = it }, placeholder = "Search ${available.size} plugins")
    val results = browseResults(available, query)
    if (results.isEmpty()) {
        Note(if (available.isEmpty()) "Everything these marketplaces offer is installed." else "No plugin matches “${query.trim()}”.")
        return
    }
    Group {
        results.forEachIndexed { i, p ->
            if (i > 0) Divider()
            AvailableRow(p, busy = p.id in plugins.busy) { act("install", p.id) }
        }
    }
}

@Composable
private fun AvailableRow(p: UniffiAvailablePlugin, busy: Boolean, onInstall: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(start = Tokens.Space4, end = Tokens.Space3, top = 12.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(p.name, color = Tokens.Text, fontSize = Tokens.TextLg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            p.description?.let { Text(it, color = Tokens.TextMuted, fontSize = Tokens.TextSm, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            val installs = p.installCount?.let { "%,d installs".format(it.toLong()) }
            Text(listOfNotNull(p.marketplace, installs).joinToString(", "), color = Tokens.TextDim, fontSize = Tokens.TextXs, maxLines = 1)
        }
        SecondaryButton(if (busy) "Installing…" else "Install", onClick = onInstall, enabled = !busy)
    }
}

@Composable
private fun Spinner() = CircularProgressIndicator(Modifier.padding(horizontal = Tokens.Space3).size(20.dp), color = Tokens.TextMuted, strokeWidth = 2.dp)

@Composable
private fun Note(text: String) = Text(text, color = Tokens.TextMuted, fontSize = Tokens.TextMd, modifier = Modifier.padding(horizontal = Tokens.Space2))

@Composable
private fun ErrorLine(text: String) = Text(
    text,
    color = Tokens.Danger,
    fontSize = Tokens.TextSm,
    modifier = Modifier
        .fillMaxWidth()
        .clip(RoundedCornerShape(Tokens.RadiusMd))
        .background(Tokens.Danger.copy(alpha = 0.12f))
        .padding(Tokens.Space3),
)

/** [PluginsContent] for [agentId] on the machine [pubkey], from the core; closes when the machine goes away. */
@Composable
fun PluginsScreen(core: CoreHost, pubkey: String, agentId: String, onBack: () -> Unit) {
    val machinesView by core.machines.collectAsState()
    val scope = rememberCoroutineScope()
    val machine = machinesView?.machines?.find { it.pubkeyHex == pubkey }
    if (machine == null) {
        if (machinesView != null) LaunchedEffect(Unit) { onBack() }
        return
    }
    PluginsContent(machine, agentId, dispatch = { intent -> scope.launch { core.dispatch(intent) } }, onBack = onBack)
}
