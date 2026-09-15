# Oracle VM handoff

Verified 2026-09-15: the same single instance is running. Raydio is active on
release `06c8eb92d319ebd5abc9c6b937180463db04ba16` (v0.2.2), Testbot is inactive,
and the VM has about 562 MiB available RAM. Six short sender-queue **loopback**
experiments ran as separate unprivileged processes and completed; no service
was restarted or deployed. See `docs/SENDER-QUEUE-VALIDATION-2026-09-15.md`.
SSH is restricted to administrator `/32` addresses in the OCI security list;
if the local public IP changes, verify it and add only that single TCP/22 rule
while preserving the existing rules/ETag. The September 15 timeout was resolved
this way, without rebooting the VM or changing the other project's access.

This is the existing single Always Free VM used by Raydio. Reuse it; do not
create a second instance or select a paid shape.

- Region: `sa-saopaulo-1` (São Paulo)
- Shape: `VM.Standard.E2.1.Micro` (x86-64; Oracle reports 1 GiB RAM)
- Public IP: `137.131.202.133`
- Instance OCID: `ocid1.instance.oc1.sa-saopaulo-1.antxeljrqqeoexqcd6trhgcgtbmvhtfvi52yx6o6vhseawv2iv3iuucsrwpq`
- Compartment OCID: `ocid1.tenancy.oc1..aaaaaaaaohhfxm2tjcamdbzrkzq5izjrrifreosj2r6okw7o5wp6j6scibxq`
- OS: Ubuntu 24.04 x86-64; boot disk about 45 GiB (41 GiB free at handoff)
- SSH: `ubuntu@137.131.202.133`, local private key `/home/rayan/.ssh/id_ed25519`
- Existing service account: `raydio`; state `/var/lib/raydio`

Raydio currently owns `raydio.service`, enabled at boot, with its binary under
`/opt/raydio/current`. It uses a 256 MiB cgroup memory maximum, 128 MiB
MemoryHigh, 32-task limit, and outbound-only network access. It was using about
7.8 MiB PSS at idle during this handoff. Do not stop or restart it while testing
the other project without an explicit coordinated maintenance window.

The VM has no compiler/container runtime requirement for Raydio. Its deployment
tool is `/usr/local/bin/raydioctl`; the release procedure is documented in
`deploy/README.md`. The OCI CLI is available locally as `/home/rayan/bin/oci`,
with config `/home/rayan/.oci/config` (profile region `sa-saopaulo-1`) and a
passphrase-protected API key at `/home/rayan/.oci/oci_api_key.pem`. Do not copy
the private key, API passphrase, Discord tokens, or `/etc/raydio/env` into a
repository or command line. The OCI CLI may prompt for the key passphrase.

For a second project, create a distinct unprivileged service user, state/data
directory, environment file (`0600`), systemd unit, and deployment directory.
Choose a unique service name and local ports. Keep the process within the
remaining 1 GiB budget and measure cgroup memory/PSS and CPU before enabling it
at boot. Raydio needs outbound DNS/HTTPS/WSS and outbound UDP for Discord; no
inbound application port is required. The instance firewall currently permits
SSH and established traffic while rejecting unsolicited inbound traffic.

The second project must use its own credentials and must not reuse Raydio's
Discord token. Coordinate restarts because Oracle host maintenance and CPU
steal can affect both workloads; avoid builds, tracing, or large downloads while
qualifying audio.
