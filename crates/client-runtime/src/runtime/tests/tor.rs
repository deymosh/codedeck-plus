use super::*;

/// Records every `set_proxy` call — used to check the HTTP port's own
/// boot-time proxy wiring, the twin of `WsConfig.proxy` above.
#[derive(Default)]
struct RecordingHttp {
    proxy_calls: RefCell<Vec<Option<String>>>,
}

impl crate::attachments::HttpFetch for RecordingHttp {
    fn put(
        &self,
        _url: &str,
        _headers: Vec<(String, String)>,
        _body: Vec<u8>,
    ) -> crate::ports::LocalBoxFuture<'_, Result<crate::attachments::HttpResponse, String>>
    {
        Box::pin(async { Err("not used".to_string()) })
    }
    fn set_proxy(&self, proxy: Option<&str>) {
        self.proxy_calls.borrow_mut().push(proxy.map(str::to_string));
    }
}

#[tokio::test]
async fn spawn_applies_the_boot_time_proxy_to_the_http_port_when_tor_is_on() {
    LocalSet::new()
        .run_until(async {
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let spy = Rc::new(Spy::default());
            let recording = Rc::new(RecordingHttp::default());
            let ports = CorePorts {
                http: Rc::clone(&recording) as Rc<dyn crate::attachments::HttpFetch>,
                ..CorePorts::default()
            };
            let _core = Core::spawn(
                CoreConfig {
                    identity: Rc::new(crate::signer::LocalSigner(phone.clone())),
                    proxy: Some("127.0.0.1:9050".to_string()),
                    tor: true,
                    device_label: None,
                    reconnect: fast_reconnect(),
                },
                ports,
                spy,
                Rc::new(FixedClock(RefCell::new(1_000_000))),
                Rc::new(ZeroEntropy),
            )
            .await;

            assert_eq!(
                recording.proxy_calls.borrow().as_slice(),
                [Some("127.0.0.1:9050".to_string())]
            );
        })
        .await;
}

/// A host that starts with Tor off must not have leaked the proxy address
/// to the HTTP port at all — `tor_proxy_address` is remembered for a later
/// `Intent::SetTorEnabled(true)`, but the port itself stays direct until then.
#[tokio::test]
async fn spawn_leaves_the_http_port_direct_when_tor_is_off() {
    LocalSet::new()
        .run_until(async {
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let spy = Rc::new(Spy::default());
            let recording = Rc::new(RecordingHttp::default());
            let ports = CorePorts {
                http: Rc::clone(&recording) as Rc<dyn crate::attachments::HttpFetch>,
                ..CorePorts::default()
            };
            let _core = Core::spawn(
                CoreConfig {
                    identity: Rc::new(crate::signer::LocalSigner(phone.clone())),
                    proxy: Some("127.0.0.1:9050".to_string()),
                    tor: false,
                    device_label: None,
                    reconnect: fast_reconnect(),
                },
                ports,
                spy,
                Rc::new(FixedClock(RefCell::new(1_000_000))),
                Rc::new(ZeroEntropy),
            )
            .await;

            assert!(recording.proxy_calls.borrow().is_empty());
        })
        .await;
}

/// Spawn a core with the given Tor settings; the caller points it at relays.
/// The `fast_reconnect` override keeps the FSM timers out of the test's way.
async fn core_with_tor(
    phone: &Keypair,
    spy: Rc<Spy>,
    ports: CorePorts,
    proxy: Option<String>,
    tor: bool,
) -> Core {
    Core::spawn(
        CoreConfig {
            identity: Rc::new(crate::signer::LocalSigner(phone.clone())),
            proxy,
            tor,
            device_label: None,
            reconnect: fast_reconnect(),
        },
        ports,
        spy,
        Rc::new(FixedClock(RefCell::new(1_000_000))),
        Rc::new(ZeroEntropy),
    )
    .await
}

/// A SOCKS5 proxy on loopback that records every `CONNECT` target and, for a
/// reachable target, forwards the connection. A test asserts through it that
/// traffic expected to be proxied really is — and that traffic expected to be
/// direct never appears here.
struct SocksProxy {
    /// `127.0.0.1:<port>` — the proxy address a `CoreConfig` is given.
    address: String,
    connects: mpsc::UnboundedReceiver<(String, u16)>,
}

impl SocksProxy {
    async fn spawn() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let (tx, connects) = mpsc::unbounded_channel();
        tokio::task::spawn_local(async move {
            while let Ok((socket, _)) = listener.accept().await {
                tokio::task::spawn_local(serve_socks5(socket, tx.clone()));
            }
        });
        Self { address, connects }
    }

    /// The next `CONNECT` the proxy saw, or `None` if none came within `within`.
    async fn next_connect(&mut self, within: Duration) -> Option<(String, u16)> {
        tokio::time::timeout(within, self.connects.recv()).await.ok().flatten()
    }

    /// A `CONNECT` the proxy saw and nobody consumed yet.
    fn pending_connect(&mut self) -> Option<(String, u16)> {
        self.connects.try_recv().ok()
    }
}

/// Serve one SOCKS5 client: no-auth greeting, one `CONNECT`, then forward.
/// A `.onion` name cannot be resolved here, so it is refused the way a Tor
/// proxy refuses a service it cannot reach — the point for the tests is that
/// the request reached the proxy at all.
async fn serve_socks5(
    mut client: tokio::net::TcpStream,
    connects: mpsc::UnboundedSender<(String, u16)>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut greeting = [0u8; 2];
    if client.read_exact(&mut greeting).await.is_err() || greeting[0] != 5 {
        return;
    }
    let mut methods = vec![0u8; greeting[1] as usize];
    if client.read_exact(&mut methods).await.is_err() {
        return;
    }
    if client.write_all(&[5, 0]).await.is_err() {
        return;
    }

    let mut request = [0u8; 4];
    if client.read_exact(&mut request).await.is_err() || request[0] != 5 || request[1] != 1 {
        return;
    }
    let host = match request[3] {
        1 => {
            let mut ip = [0u8; 4];
            if client.read_exact(&mut ip).await.is_err() {
                return;
            }
            ip.iter().map(|b| b.to_string()).collect::<Vec<_>>().join(".")
        }
        3 => {
            let mut len = [0u8; 1];
            if client.read_exact(&mut len).await.is_err() {
                return;
            }
            let mut name = vec![0u8; len[0] as usize];
            if client.read_exact(&mut name).await.is_err() {
                return;
            }
            String::from_utf8_lossy(&name).to_string()
        }
        4 => {
            let mut ip = [0u8; 16];
            if client.read_exact(&mut ip).await.is_err() {
                return;
            }
            std::net::Ipv6Addr::from(ip).to_string()
        }
        _ => return,
    };
    let mut port = [0u8; 2];
    if client.read_exact(&mut port).await.is_err() {
        return;
    }
    let port = u16::from_be_bytes(port);
    let _ = connects.send((host.clone(), port));

    if host.ends_with(".onion") {
        let _ = client.write_all(&[5, 4, 0, 1, 0, 0, 0, 0, 0, 0]).await;
        return;
    }
    match tokio::net::TcpStream::connect((host.as_str(), port)).await {
        Ok(mut upstream) => {
            if client.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.is_err() {
                return;
            }
            let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
        }
        Err(_) => {
            let _ = client.write_all(&[5, 4, 0, 1, 0, 0, 0, 0, 0, 0]).await;
        }
    }
}

/// Tor is switched on while the core is already connected: the next relay
/// connection is dialled through the SOCKS5 proxy (no Nostr traffic takes a
/// direct path while Tor is on), Blossom uploads follow, and switching Tor
/// off redials relay traffic directly.
#[tokio::test]
async fn toggling_tor_at_runtime_moves_relay_and_http_traffic_through_the_proxy_and_back() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let spy = Rc::new(Spy::default());
            let recording = Rc::new(RecordingHttp::default());
            let mut proxy = SocksProxy::spawn().await;
            let proxy_address = proxy.address.clone();

            let core = core_with_tor(
                &phone,
                Rc::clone(&spy),
                CorePorts {
                    http: Rc::clone(&recording) as Rc<dyn crate::attachments::HttpFetch>,
                    ..CorePorts::default()
                },
                Some(proxy_address.clone()),
                false,
            )
            .await;
            core.set_machines(vec![generate_keypair().pubkey_hex]);
            core.set_relays(vec![mock.url.clone()]);
            core.start();
            eose_all(&mut mock).await;
            while mock.try_accept() {}
            assert!(
                proxy.pending_connect().is_none(),
                "with Tor off the relay connection must not touch the proxy"
            );
            assert!(recording.proxy_calls.borrow().is_empty(), "with Tor off Blossom stays direct");

            core.dispatch(Intent::SetTorEnabled(true)).await;
            let relay = mock.url.trim_start_matches("ws://").to_string();
            let (relay_host, relay_port) = relay.split_once(':').unwrap();
            assert_eq!(
                proxy.next_connect(Duration::from_secs(5)).await,
                Some((relay_host.to_string(), relay_port.parse().unwrap())),
                "enabling Tor must redial the relay through the proxy"
            );
            assert!(
                mock.next_accept(Duration::from_secs(5)).await,
                "the proxied relay dial must reach the relay"
            );
            assert_eq!(
                recording.proxy_calls.borrow().as_slice(),
                [Some(proxy_address.clone())],
                "Blossom uploads must follow the same switch"
            );
            assert!(proxy.pending_connect().is_none(), "one relay, one proxied dial");

            core.dispatch(Intent::SetTorEnabled(false)).await;
            assert!(
                mock.next_accept(Duration::from_secs(5)).await,
                "disabling Tor must redial the relay"
            );
            assert!(
                proxy.pending_connect().is_none(),
                "a relay dial with Tor off must bypass the proxy"
            );
            assert_eq!(
                recording.proxy_calls.borrow().as_slice(),
                [Some(proxy_address.clone()), None],
                "Blossom is direct again once Tor is off"
            );
        })
        .await;
}

/// Enabling Tor at runtime swaps in the Tor reconnect timing: the connect
/// deadline must cover the slower dial the proxy just introduced. With the
/// clearnet deadline still in force, an attempt that is still dialling is
/// abandoned long before Tor's own transport would give up.
#[tokio::test]
async fn enabling_tor_at_runtime_widens_the_connect_deadline_to_tors() {
    LocalSet::new()
        .run_until(async {
            // Accepts the TCP connection but never answers the WebSocket
            // handshake, so the attempt stays `Connecting`.
            let silent = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let relay = format!("ws://{}", silent.local_addr().unwrap());
            tokio::task::spawn_local(async move {
                let mut held = Vec::new();
                while let Ok((socket, _)) = silent.accept().await {
                    held.push(socket);
                }
            });
            let proxy = SocksProxy::spawn().await;
            let clock = Rc::new(FixedClock(RefCell::new(1_000_000)));
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let core = Core::spawn(
                CoreConfig {
                    identity: Rc::new(crate::signer::LocalSigner(phone)),
                    proxy: Some(proxy.address.clone()),
                    tor: false,
                    device_label: None,
                    reconnect: DEFAULT_RECONNECT_CONFIG,
                },
                CorePorts::default(),
                Rc::new(Spy::default()),
                Rc::clone(&clock) as Rc<dyn Clock>,
                Rc::new(ZeroEntropy),
            )
            .await;
            core.set_machines(vec![generate_keypair().pubkey_hex]);
            core.set_relays(vec![relay]);
            core.start();
            assert_eq!(
                core.connection_status().await.0,
                ConnectionStatus::Connecting,
                "the attempt starts on the clearnet timing"
            );

            core.dispatch(Intent::SetTorEnabled(true)).await;
            *clock.0.borrow_mut() += DEFAULT_RECONNECT_CONFIG.connect_deadline_ms + 1;
            core.tick();
            assert_eq!(
                core.connection_status().await.0,
                ConnectionStatus::Connecting,
                "enabling Tor must widen the connect deadline, not keep the clearnet one"
            );

            *clock.0.borrow_mut() = 1_000_000 + TOR_RECONNECT_CONFIG.connect_deadline_ms;
            core.tick();
            assert_eq!(
                core.connection_status().await.0,
                ConnectionStatus::WaitingRetry,
                "the Tor deadline still bounds an attempt that never reaches EOSE"
            );
        })
        .await;
}

/// With Tor on, a direct link's `.onion` endpoint goes through the proxy —
/// only Tor reaches it — while a LAN endpoint is dialled directly. A direct
/// link is the user's own bridge on their own network, not Nostr traffic.
#[tokio::test]
async fn with_tor_on_a_direct_link_proxies_its_onion_endpoint_and_dials_lan_directly() {
    LocalSet::new()
        .run_until(async {
            let lan = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let lan_address = lan.local_addr().unwrap();
            let (lan_hit_tx, mut lan_hit_rx) = mpsc::unbounded_channel();
            tokio::task::spawn_local(async move {
                let mut held = Vec::new();
                while let Ok((socket, _)) = lan.accept().await {
                    held.push(socket);
                    let _ = lan_hit_tx.send(());
                }
            });
            let mut proxy = SocksProxy::spawn().await;

            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let mut state = client_core::stores::machines::MachinesState::default();
            state.register_machine(&machine.pubkey_hex, "bridge", None, None, &[]);
            state.machines.get_mut(&machine.pubkey_hex).unwrap().direct = Some(protocol::direct::DirectInfo {
                endpoints: vec!["ws://abc.onion:7448".into(), format!("ws://{lan_address}")],
                cert_sha256: None,
            });
            let kv = MemoryKv::seeded([(
                crate::stores::MACHINES_KEY,
                client_core::stores::machines::serialize_machines(&state.machines),
            )]);
            // No relay is configured: nothing but the direct link may reach
            // the proxy, so its CONNECT log is unambiguous.
            let core = core_with_tor(
                &phone,
                Rc::new(Spy::default()),
                CorePorts { kv: Rc::new(kv), ..CorePorts::default() },
                Some(proxy.address.clone()),
                true,
            )
            .await;
            core.start();

            assert_eq!(
                proxy.next_connect(Duration::from_secs(5)).await,
                Some(("abc.onion".to_string(), 7448)),
                "the onion endpoint must be dialled through the proxy"
            );
            tokio::time::timeout(Duration::from_secs(5), lan_hit_rx.recv())
                .await
                .expect("the LAN endpoint must be dialled")
                .expect("the LAN listener is alive");
            assert!(
                proxy.pending_connect().is_none(),
                "the LAN endpoint must be dialled directly, never through the proxy"
            );
        })
        .await;
}
