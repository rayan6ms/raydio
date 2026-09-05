use crate::resolver::Limits;
use anyhow::{Result, bail};
use std::collections::HashMap;

#[derive(Clone)]
pub struct Config {
    pub token: String,
    pub log_level: String,
    pub volume: u16,
    pub idle_seconds: u64,
    pub alone_seconds: u64,
    pub pending: usize,
    pub limits: Limits,
}
impl Config {
    pub fn from_env(env: &HashMap<String, String>, testbot: bool) -> Result<Self> {
        let token_key = if testbot {
            "DISCORD_TOKEN_TESTBOT"
        } else {
            "DISCORD_TOKEN"
        };
        let token = env
            .get(token_key)
            .filter(|value| {
                !value.is_empty() && value.trim() == *value && !value.chars().any(char::is_control)
            })
            .ok_or_else(|| {
                anyhow::anyhow!("{token_key}: a nonempty single-line token is required")
            })?
            .clone();
        let log_level = env
            .get("LOG_LEVEL")
            .cloned()
            .unwrap_or_else(|| "info".into());
        if !["fatal", "error", "warn", "info", "debug", "trace", "silent"]
            .contains(&log_level.as_str())
        {
            bail!("LOG_LEVEL: invalid log level");
        }
        let integer = |name: &str, default: u64, min: u64, max: u64| -> Result<u64> {
            let Some(raw) = env.get(name) else {
                return Ok(default);
            };
            let raw = raw.trim();
            if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
                bail!("{name}: decimal integer required");
            }
            let value = raw
                .parse::<u64>()
                .map_err(|_| anyhow::anyhow!("{name}: integer out of range"))?;
            if value < min || value > max {
                bail!("{name}: must be between {min} and {max}");
            }
            Ok(value)
        };
        let max = 9_007_199_254_740_991;
        let allow_streams = match env.get("ALLOW_LIVESTREAMS").map(String::as_str) {
            None | Some("false") => false,
            Some("true") => true,
            _ => bail!("ALLOW_LIVESTREAMS: must be exactly true or false"),
        };
        let hours = integer("MAX_TRACK_DURATION_HOURS", 3, 1, max / 3_600_000)?;
        Ok(Self {
            token,
            log_level,
            volume: integer("DEFAULT_VOLUME", 70, 0, 100)? as u16,
            idle_seconds: integer("IDLE_DISCONNECT_SECONDS", 120, 1, max / 1000)?,
            alone_seconds: integer("ALONE_DISCONNECT_SECONDS", 120, 1, max / 1000)?,
            pending: integer("MAX_PENDING_PLAY_REQUESTS", 10, 1, max)? as usize,
            limits: Limits {
                playlists: integer("MAX_PLAYLIST_TRACKS", 250, 1, max)? as usize,
                queue: integer("MAX_QUEUE_TRACKS", 1000, 1, max)? as usize,
                max_duration_ms: hours * 3_600_000,
                allow_streams,
            },
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn env() -> HashMap<String, String> {
        HashMap::from([
            ("DISCORD_TOKEN".into(), "test-only".into()),
            ("DISCORD_TOKEN_TESTBOT".into(), "another-test-only".into()),
        ])
    }
    #[test]
    fn testbot_selection_is_explicit() {
        assert_eq!(Config::from_env(&env(), false).unwrap().token, "test-only");
        assert_eq!(
            Config::from_env(&env(), true).unwrap().token,
            "another-test-only"
        );
    }
    #[test]
    fn defaults_match_counterpart() {
        let c = Config::from_env(&env(), false).unwrap();
        assert_eq!(
            (c.volume, c.idle_seconds, c.alone_seconds, c.pending),
            (70, 120, 120, 10)
        );
        assert_eq!(
            (c.limits.playlists, c.limits.queue, c.limits.max_duration_ms),
            (250, 1000, 10_800_000)
        );
    }
    #[test]
    fn invalid_configuration_never_quotes_the_value() {
        for (key, value) in [
            ("DISCORD_TOKEN", " private-token "),
            ("DEFAULT_VOLUME", "101"),
            ("MAX_QUEUE_TRACKS", "1e3"),
            ("ALLOW_LIVESTREAMS", "1"),
            ("MAX_TRACK_DURATION_HOURS", "999999999999999"),
        ] {
            let mut env = env();
            env.insert(key.into(), value.into());
            let error = Config::from_env(&env, false).err().unwrap().to_string();
            assert!(error.contains(key));
            assert!(!error.contains(value));
        }
    }
}
