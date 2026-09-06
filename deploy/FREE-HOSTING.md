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

## Traffic budget from the real bot

The complete `udp-send-oracle-source-diagnostic.json` track emitted about
14,535 bytes/s of UDP datagrams. Adding IPv4/UDP headers gives approximately
57.3 MB/hour, or 39.0 GiB per 730 hours, for one guild at the measured codec
settings. Control traffic is additional. This is an estimate from one track,
not a provider invoice; variable bitrate, number of active guilds, and playback
hours matter. Memory below 20 MiB does not make the network traffic free.

## Current official offers

| Provider | Relevant offer | Fit for this bot |
| --- | --- | --- |
| Oracle Always Free | E2.1.Micro: 1/8 OCPU, 1 GiB, up to 50 Mbps internet; 10 TB monthly outbound allowance. A1 is capacity-dependent. | Existing host has sufficient RAM and bandwidth. The receiver has recorded intermittent gaps; continuous audio is not yet qualified. |
| Northflank Developer Sandbox | Two free services, always-on compute. Current docs require a payment method for all plans and describe Sandbox as unsuitable for production applications. | Best alternative to investigate. Its official Discord music-bot guide establishes platform capability, but current Sandbox egress allowance/cost ceiling and free-resource availability must be confirmed in the account before deployment. |
| Railway Free | $1 credit/month after the initial trial; maximum 512 MB and 1 vCPU. RAM $10/GB-month, CPU $20/vCPU-month, egress $0.05/GB. | May fit light use, not continuous music: estimated voice egress alone is about $1.95/month. Trial verification can restrict outbound networking. Free-plan outbound UDP and credit-exhaustion behavior require verification. The configurable hard limit has a $10 minimum and is not a $1 safeguard. |
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

The Discloud, Square Cloud, and bot-hosting.net public pages rejected the
research client (HTTP 403); their current Rust support, music policies,
renewal conditions, and free bandwidth could not be verified. They are not
ranked as qualified alternatives on the basis of third-party claims.

There is currently no independently tested alternative that can be promised
to meet both zero cost and uninterrupted playback. Northflank is a candidate,
not an approved migration. Existing home hardware is another option with no
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
