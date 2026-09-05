//! Optional systemd readiness, without a resident supervisor or extra dependency.
pub fn ready() {
    #[cfg(unix)]
    if let Some(path) = std::env::var_os("NOTIFY_SOCKET")
        && send_ready(&path).is_err()
    {
        tracing::warn!("Could not notify service manager of readiness");
    }
}

#[cfg(unix)]
fn send_ready(path: &std::ffi::OsStr) -> std::io::Result<()> {
    use std::os::unix::{ffi::OsStrExt, net::UnixDatagram};
    let socket = UnixDatagram::unbound()?;
    socket.set_write_timeout(Some(std::time::Duration::from_secs(1)))?;
    let data = b"READY=1\nSTATUS=Connected to Discord";
    #[cfg(target_os = "linux")]
    if let Some(name) = path.as_bytes().strip_prefix(b"@") {
        use std::os::linux::net::SocketAddrExt;
        let address = std::os::unix::net::SocketAddr::from_abstract_name(name)?;
        socket.send_to_addr(data, &address)?;
        return Ok(());
    }
    socket.send_to(data, path)?;
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    #[test]
    fn readiness_is_sent_to_service_manager() {
        use std::os::unix::net::UnixDatagram;
        let path = std::env::temp_dir().join(format!(
            "raydio-notify-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let receiver = UnixDatagram::bind(&path).unwrap();
        receiver
            .set_read_timeout(Some(std::time::Duration::from_secs(1)))
            .unwrap();
        super::send_ready(path.as_os_str()).unwrap();
        let mut data = [0; 128];
        let count = receiver.recv(&mut data).unwrap();
        std::fs::remove_file(path).unwrap();
        assert_eq!(&data[..count], b"READY=1\nSTATUS=Connected to Discord");
    }
}
