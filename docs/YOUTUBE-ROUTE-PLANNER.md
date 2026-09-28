# YouTube outbound route planner

Raydio now exposes the Crust/Lavalink-style local-address route planner through
the deployment environment. It is intentionally disabled unless an operator
provides a real pool of local source addresses. A route planner cannot create
new public IPs and does not turn one Oracle address into multiple egresses.

The optional settings are:

```dotenv
RAYDIO_ROUTE_PLANNER_IP_BLOCKS=203.0.113.0/30,2001:db8:1234::/64
RAYDIO_ROUTE_PLANNER_STRATEGY=rotate_on_ban
RAYDIO_ROUTE_PLANNER_EXCLUDED_ADDRESSES=203.0.113.1
RAYDIO_ROUTE_PLANNER_SEARCH_TRIGGERS_FAIL=true
RAYDIO_ROUTE_PLANNER_MAX_FAILURES=4096
```

Use addresses that are actually assigned to the host or provided through a
configured network route. `rotate_on_ban`, `load_balance`, `nano_switch`, and
`rotating_nano_switch` map to the four Lavalink-compatible planner strategies.
The planner keeps bounded failure state, retires a route after transport/rate
limit failures, and shares its selection with Mantle source and media requests.

YouTube's `LOGIN_REQUIRED` anti-bot response is treated as a route-rate-limit
signal, so an enabled planner can retire an egress that YouTube challenges.
With no alternate route, playback still fails predictably and no route rotation
is attempted.

This feature is not a VPN or proxy. A shared VPN endpoint is just one route and
often has worse reputation than Oracle. Reliable operation requires multiple
clean egresses or a dedicated residential proxy pool, and each route must be
validated against representative YouTube playback before production use.
