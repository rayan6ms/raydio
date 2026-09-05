use crate::{
    playback::Track,
    urls::{Input, classify, valid_identifier},
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Debug)]
pub struct Limits {
    pub playlists: usize,
    pub queue: usize,
    pub max_duration_ms: u64,
    pub allow_streams: bool,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            playlists: 250,
            queue: 1000,
            max_duration_ms: 10_800_000,
            allow_streams: false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Failure {
    NoMatch,
    InvalidResponse,
    LoadFailed,
    Unavailable,
    Unsupported,
    Full,
}
#[derive(Clone, Debug)]
pub struct Resolution {
    pub tracks: Vec<Track>,
    pub playlist: Option<String>,
    pub rejected: usize,
    pub omitted: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Info {
    identifier: String,
    title: String,
    author: String,
    length: u64,
    is_stream: bool,
    uri: Option<String>,
    source_name: String,
}
#[derive(Deserialize)]
struct RawTrack {
    encoded: String,
    info: Info,
}

/// Normalize Lavalink v4 data with the same acceptance policy as Raydio's TypeScript resolver.
pub fn normalize(
    value: Value,
    playlist: bool,
    search: bool,
    capacity: usize,
    limits: &Limits,
) -> Result<Resolution, Failure> {
    if capacity == 0 {
        return Err(Failure::Full);
    }
    let raw = match value["loadType"].as_str() {
        Some("error") => return Err(Failure::LoadFailed),
        Some("empty") => return Err(Failure::NoMatch),
        Some("track") => vec![value["data"].clone()],
        Some("playlist") => value["data"]["tracks"]
            .as_array()
            .cloned()
            .ok_or(Failure::InvalidResponse)?,
        Some("search") => value["data"]
            .as_array()
            .cloned()
            .ok_or(Failure::InvalidResponse)?,
        _ => return Err(Failure::InvalidResponse),
    };
    let limit = capacity.min(limits.queue).min(if playlist {
        limits.playlists
    } else if search {
        capacity
    } else {
        1
    });
    let mut result = Resolution {
        tracks: Vec::new(),
        playlist: if value["loadType"] == "playlist" {
            value["data"]["info"]["name"].as_str().map(str::to_owned)
        } else {
            None
        },
        rejected: 0,
        omitted: 0,
    };
    for raw in raw {
        let Ok(raw) = serde_json::from_value::<RawTrack>(raw) else {
            result.rejected += 1;
            continue;
        };
        if raw.encoded.trim().is_empty()
            || raw.info.length > limits.max_duration_ms
            || (!limits.allow_streams && raw.info.is_stream)
            || (search
                && (raw.info.source_name != "youtube" || !valid_identifier(&raw.info.identifier)))
        {
            result.rejected += 1;
            continue;
        }
        if result.tracks.len() >= limit {
            if playlist {
                result.omitted += 1;
            }
            continue;
        }
        result.tracks.push(Track {
            encoded: raw.encoded,
            identifier: raw.info.identifier,
            title: raw.info.title,
            author: raw.info.author,
            duration_ms: raw.info.length,
            stream: raw.info.is_stream,
            uri: raw.info.uri,
            requester_id: String::new(),
            requested_by: String::new(),
        });
        if !playlist && !search {
            break;
        }
    }
    if result.tracks.is_empty() {
        Err(Failure::NoMatch)
    } else {
        Ok(result)
    }
}

pub fn identifiers(input: &str) -> Result<(String, Option<String>, bool), Failure> {
    match classify(input) {
        Input::Search(query) if !query.is_empty() => Ok((
            format!("ytmsearch:{query}"),
            Some(format!("ytsearch:{query}")),
            false,
        )),
        Input::Search(_) => Err(Failure::NoMatch),
        Input::Video(url) => Ok((url, None, false)),
        Input::Playlist(url) => Ok((url, None, true)),
        Input::Unsupported => Err(Failure::Unsupported),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn raw(id: &str, duration: u64, stream: bool) -> Value {
        json!({"encoded":id,"info":{"identifier":id,"title":id,"author":"a","length":duration,"isStream":stream,"uri":null,"sourceName":"youtube"}})
    }
    #[test]
    fn playlist_limits_count_omitted_and_unsuitable_separately() {
        let value = json!({"loadType":"playlist","data":{"info":{"name":"p"},"tracks":[raw("live",0,true),raw("long",10_800_001,false),raw("a",1000,false),raw("b",1000,false),raw("c",1000,false)]}});
        let result = normalize(value, true, false, 2, &Limits::default()).unwrap();
        assert_eq!(result.tracks.len(), 2);
        assert_eq!(result.rejected, 2);
        assert_eq!(result.omitted, 1);
        assert_eq!(result.playlist.as_deref(), Some("p"));
    }
    #[test]
    fn direct_input_does_not_enqueue_a_whole_search() {
        let value = json!({"loadType":"search","data":[raw("a",1,false),raw("b",1,false)]});
        assert_eq!(
            normalize(value, false, false, 10, &Limits::default())
                .unwrap()
                .tracks
                .len(),
            1
        );
    }
    #[test]
    fn load_errors_are_distinct_from_empty_results() {
        assert_eq!(
            normalize(
                json!({"loadType":"error"}),
                false,
                true,
                1,
                &Limits::default()
            )
            .unwrap_err(),
            Failure::LoadFailed
        );
        assert_eq!(
            normalize(
                json!({"loadType":"empty"}),
                false,
                true,
                1,
                &Limits::default()
            )
            .unwrap_err(),
            Failure::NoMatch
        );
    }
    #[test]
    fn invalid_source_cannot_become_a_search_choice() {
        let mut track = raw("a", 1, false);
        track["info"]["sourceName"] = json!("http");
        assert_eq!(
            normalize(
                json!({"loadType":"search","data":[track]}),
                false,
                true,
                10,
                &Limits::default()
            )
            .unwrap_err(),
            Failure::NoMatch
        );
    }
}
