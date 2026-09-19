//! Trivial — its only job is to be a second workspace member depending on
//! `client-core`, so the workspace's feature resolution for `rusqlite` /
//! `openssl-src` is exercised the way the real `client-runtime` will exercise it.

pub fn re_export_check() -> bool {
    // reference a client-core symbol so the dep edge is real
    let _ = client_core::MarmotService::open;
    true
}
