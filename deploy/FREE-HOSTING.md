# Free hosting assessment — 2026-09-06

Raydio needs an always-running process, outbound HTTPS/WebSockets and UDP with
stateful replies, source access from the host's public IP, and stable 20 ms
audio delivery. A web service that sleeps without incoming HTTP requests is
not a substitute. No public inbound application port is needed.

The existing Oracle VM remains the only instance. No paid plan or second VM
was created. Its memory capacity is ample; audio qualification remains a
separate gate. A read-only capacity report at 12:07 UTC again returned
`OUT_OF_HOST_CAPACITY` for a one-OCPU, one-GiB A1 in São Paulo. A1 has not been
performance-tested, so Micro results do not establish that all Oracle shapes
are unsuitable.

The subsequent same-binary 150-second comparison measured maximum outgoing
packet intervals of 21.027 ms locally and 100.277 ms on Micro, with 0 versus
16 intervals over 40 ms. Receiver concealment was 74.708 versus 796.750 ms;
neither window had silent blocks or clipping. This confirms a timing gap to
investigate, without claiming a controlled proof that the hypervisor alone
causes it. See `evidence/oracle-local-pooled-comparison.json`.

Later diagnosis found dynamic SSH login status scripts disturbing the shared
Micro during measurement. Their refresh is now disabled. A quiet 150-second
release run then had no sender intervals over 40 ms, maximum 34.359 ms, and
95.563 ms receiver concealment, with no loss, silent PCM blocks, clipping, or
speaking changes. This is close to the earlier local capture's 74.708 ms
concealment, but other quiet runs still had late frames. No alternative has
been proven better or necessary on this evidence alone. See
`evidence/oracle-quiet-comparison.json` and `evidence/ORACLE-RELIABILITY.md`.

## Traffic budget from the real bot

The complete `udp-send-oracle-source-diagnostic.json` track emitted about
14,535 bytes/s of UDP datagrams. Adding IPv4/UDP headers gives approximately
57.3 MB/hour, or 39.0 GiB per 730 hours, for one guild at the measured codec
settings. Control traffic is additional. This is an estimate from one track,
not a provider invoice; variable bitrate, number of active guilds, and playback
hours matter. Memory below 20 MiB does not make the network traffic free.

The requested workload is **up to six hours/day, one voice channel**: 180 hours
in a 30-day month, or 186 in a 31-day month. At the measured rate this is
10.33 GB (9.62 GiB) of voice egress per 30 days. At Railway's published
$0.05/GB, budget about **$0.52 for voice traffic alone** using decimal GB.
The earlier $0.48 estimate used GiB; provider accounting must settle the units.

Using 0.04–0.05 of one CPU while playing adds roughly $0.20–$0.25/month.
If billed memory averages 16–24 MiB across the full month, it adds roughly
$0.17–$0.25. Together these estimates are **$0.89–$1.02/month**, before idle CPU,
control traffic, startup, redeploy overlap, and differences in provider metering.
PSS on Oracle is not Railway's billed memory metric. Six hours/day might fit
the recurring $1 allowance, but there is insufficient margin to promise it.
No audio-quality reduction is assumed in this estimate.

GitHub sign-in was tested in the controlled browser. The account currently
shows **Limited Trial**, $5/30 days, and restricted networking. Its verification
URL redirects to the Plans page, which says to connect GitHub or add a payment
method for full network access. No project, bot token, paid plan, or payment
method was added. Free outbound voice connectivity and recurring-credit
exhaustion behavior remain unverified; the trial's $5 is not the ongoing budget.

## Current official offers

| Provider | Relevant offer | Fit for this bot |
| --- | --- | --- |
| Oracle Always Free | E2.1.Micro: 1/8 OCPU, 1 GiB, up to 50 Mbps internet; 10 TB monthly outbound allowance. A1 is capacity-dependent. | Existing host has sufficient RAM and bandwidth. The receiver has recorded intermittent gaps; continuous audio is not yet qualified. |
| Northflank Developer Sandbox | Two free services, always-on compute. Current docs require a payment method for all plans and describe Sandbox as unsuitable for production applications. | Its official Discord music-bot guide establishes platform capability, but current Sandbox egress allowance/cost ceiling and free-resource availability must be confirmed before deployment. |
| Railway Free | $1 credit/month after the initial trial; maximum 512 MB and 1 vCPU. RAM $10/GB-month, CPU $20/vCPU-month, egress $0.05/GB. | Six hours/day is borderline on the estimate above. The account currently has restricted networking. Free-plan outbound UDP and credit-exhaustion behavior require verification. The configurable hard limit has a $10 minimum and is not a $1 safeguard. |
| Discloud Free | One bot, 100 MB RAM, Rust support and custom start commands. | Enough measured RAM, but documented automatic restart is restricted to Platinum or higher. The free-application shutdown FAQ is an unfinished page, so unattended lifetime and free voice networking are unverified. |
| Bot-Hosting.net Free | One deployment, 256 MB RAM, Rust support; no card. Pricing page lists 25% CPU / 512 MB storage, while the homepage lists 20% / 1 GB. | Requires manual renewal every four days with a bot check. API/MCP document read-only billing access and no free-renewal operation. Does not meet the user's unattended-renewal requirement. Legal terms give no free uptime commitment and allow moves/restarts without notice. |
| Square Cloud | Current official plans FAQ explicitly says it is a paid platform with no free plan. | Excluded by the zero-cost requirement. Rust support does not change this. |
| Google Compute Engine Free Tier | One e2-micro in selected US regions, 30 GB standard disk, 1 GB monthly outbound allowance. | Ordinary IPv4 deployment is not free: in-use public IPv4 is $0.005/hour, apart from one free hour/month. Bandwidth is also inadequate for regular music. |
| Render Free | Free web service sleeps after 15 minutes without inbound traffic. | Unsuitable for this always-connected background process. |
| Koyeb Free | One 512 MB / 0.1 vCPU instance, restricted regions; cannot be a Worker Service and scales to zero after an hour without traffic. | Unsuitable for dependable continuous playback. |
| AWS Free plan | New-account credits, at most six months. | Temporary trial, not ongoing free hosting. |
| Azure | VM free allowances are time-limited; continuing the free account requires moving to pay-as-you-go. | Does not establish an ongoing, zero-cost bot VM. |
| Fly.io | New-user trial; legacy allowances are discontinued plans. | No verified ongoing free offer for a new deployment. |

Northflank's 2021 announcement said everything in a developer project was free.
Its current general price lists $0.06/GB egress, without clearly specifying the
Sandbox exception/allowance. Do not turn that old announcement into a guarantee
of unlimited free music bandwidth. Its 2022 music-bot guide recommends at least
0.2 vCPU / 512 MB for Muse; Raydio must be measured independently.

The first research client received HTTP 403 from Discloud, Square Cloud, and
Bot-Hosting.net. A later request with a normal browser user-agent successfully
retrieved their official pages. The findings above supersede that access failure.
Bot-Hosting.net's homepage advertises a 99% free SLA, but its legal terms
explicitly exclude the free plan from an uptime commitment; use the legal terms.
The renewal guide requires a dashboard bot check and then "Renew for 4 days".
Its public REST and MCP references expose `billing:read`, not a renewal operation.
No supported unattended renewal was found. Do not base a deployment on bypassing
that check. The user accepts periodic renewal only when it can be automated.

There is currently no independently tested alternative that can be promised
to meet both zero cost and uninterrupted playback. Railway and Northflank are
candidates, not approved migrations. Existing home hardware is another option with no
hosting subscription, but it still needs power, internet, and continuous uptime.

## Sources checked

- [Oracle Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [Northflank pricing](https://northflank.com/pricing), [current billing requirements](https://northflank.com/docs/v1/application/billing/pricing-on-northflank), [card charges](https://northflank.com/docs/v1/application/billing/add-a-card), [music-bot guide](https://northflank.com/guides/deploying-a-discord-music-bot-on-northflank), [2021 developer-project announcement](https://northflank.com/changelog/free-developer-projects)
- [Railway plans](https://docs.railway.com/pricing/plans), [trial and verification](https://docs.railway.com/pricing/free-trial), [cost limits](https://docs.railway.com/pricing/cost-control), [outbound networking](https://docs.railway.com/networking/outbound-networking)
- [Google Free Tier](https://cloud.google.com/free/docs/free-cloud-features#compute), [IP pricing](https://cloud.google.com/vpc/network-pricing)
- [Render Free](https://render.com/docs/free)
- [Koyeb instances](https://www.koyeb.com/docs/reference/instances)
- [AWS Free Tier](https://aws.amazon.com/free/)
- [Azure free services](https://azure.microsoft.com/en-us/pricing/free-services/)
- [Fly.io pricing](https://fly.io/docs/about/pricing/)
- [Discloud plans](https://discloud.com/plans), [Rust deployment](https://docs.discloud.com/development-environment/supported-languages/rust), [configuration and paid automatic restart](https://docs.discloud.com/configurations/discloud.config), [unfinished free-shutdown FAQ](https://docs.discloud.com/faq/general-questions/em-andamento-por-que-aplicacoes-gratuitas-sao-encerradas)
- [Bot-Hosting.net pricing](https://bot-hosting.net/pricing), [legal terms §§2, 3.5–3.6](https://bot-hosting.net/legal), [renewal guide](https://bot-hosting.net/docs/guides/renew-free-subscription), [REST API](https://bot-hosting.net/api), [MCP reference](https://bot-hosting.net/mcp)
- [Square Cloud plans FAQ](https://docs.squarecloud.app/en/platform/plans)
