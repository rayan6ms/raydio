use url::Url;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Input {
    Search(String),
    Video(String),
    Playlist(String),
    Unsupported,
}

pub fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn classify(input: &str) -> Input {
    let input = input.trim();
    let Ok(url) = Url::parse(input) else {
        return Input::Search(input.into());
    };
    if !matches!(url.scheme(), "https" | "http")
        || !matches!(
            url.host_str(),
            Some(
                "youtube.com"
                    | "www.youtube.com"
                    | "m.youtube.com"
                    | "music.youtube.com"
                    | "youtu.be"
            )
        )
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Input::Unsupported;
    }
    let parameter = |key: &str| {
        url.query_pairs()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.into_owned())
    };
    let segments: Vec<_> = url.path_segments().into_iter().flatten().collect();
    if let Some(list) = parameter("list").filter(|v| valid_identifier(v)) {
        // Personalized mixes cannot infer their seed from the list ID. Keep
        // the explicit video while still requesting the complete mix.
        let seed = if url.host_str() == Some("youtu.be") {
            segments.first().map(|id| (*id).to_owned())
        } else if url.path() == "/watch" {
            parameter("v")
        } else if matches!(segments.first(), Some(&"shorts" | &"live" | &"embed")) {
            segments.get(1).map(|id| (*id).to_owned())
        } else {
            None
        }
        .filter(|id| id.len() == 11 && valid_identifier(id));
        if list.starts_with("RD")
            && let Some(seed) = seed
        {
            let mut canonical = Url::parse("https://www.youtube.com/watch").expect("constant URL");
            canonical
                .query_pairs_mut()
                .append_pair("v", &seed)
                .append_pair("list", &list);
            return Input::Playlist(canonical.into());
        }
        let mut canonical = Url::parse("https://www.youtube.com/playlist").expect("constant URL");
        canonical.query_pairs_mut().append_pair("list", &list);
        return Input::Playlist(canonical.into());
    }
    let video = if url.host_str() == Some("youtu.be") {
        segments.first().is_some_and(|id| valid_identifier(id))
    } else if url.path() == "/watch" {
        parameter("v").is_some_and(|id| valid_identifier(&id))
    } else {
        matches!(segments.first(), Some(&"shorts" | &"live" | &"embed"))
            && segments.get(1).is_some_and(|id| valid_identifier(id))
    };
    if video {
        Input::Video(url.into())
    } else {
        Input::Unsupported
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn seeded_mixes_reach_mantle_with_their_original_seed() {
        use mantle_media::{YoutubeRoute, YoutubeSourceOptions, route_youtube_identifier};
        for list in ["RDdQw4w9WgXcQ", "RDMMdQw4w9WgXcQ", "RDEMfixtureMix"] {
            for origin in [
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
                "https://youtu.be/dQw4w9WgXcQ?ignored=1",
                "https://youtube.com/shorts/dQw4w9WgXcQ?ignored=1",
            ] {
                let Input::Playlist(identifier) = classify(&format!("{origin}&list={list}")) else {
                    panic!("mix classification")
                };
                assert_eq!(
                    route_youtube_identifier(&identifier, &YoutubeSourceOptions::default()),
                    Some(YoutubeRoute::Mix {
                        playlist_id: list.into(),
                        selected_video_id: "dQw4w9WgXcQ".into(),
                    })
                );
                assert!(!identifier.contains("ignored"));
            }
        }
        assert_eq!(
            classify("https://youtube.com/watch?v=bad%2Fseed&list=RDMMexample"),
            Input::Playlist("https://www.youtube.com/playlist?list=RDMMexample".into())
        );
    }
    #[test]
    fn mixed_links_keep_the_full_playlist() {
        for url in [
            "https://www.youtube.com/watch?v=video&list=playlist",
            "https://youtu.be/video?list=playlist&t=30",
            "https://music.youtube.com/watch?v=video&list=playlist",
            "https://youtube.com/shorts/video?list=playlist",
        ] {
            assert_eq!(
                classify(url),
                Input::Playlist("https://www.youtube.com/playlist?list=playlist".into())
            );
        }
    }
    #[test]
    fn media_only_and_no_arbitrary_network_targets() {
        for url in [
            "https://example.com/watch?v=video",
            "ftp://youtube.com/watch?v=video",
            "https://user:secret@youtube.com/watch?v=video",
            "https://youtube.com:8443/watch?v=video",
            "https://youtube.com/@artist",
            "https://youtu.be/",
            "https://youtube.com/watch?v=%20",
            "https://youtube.com/watch?v=video%2Fid",
            "https://youtu.be/%20",
            "https://youtube.com/playlist?list=%09",
            "https://youtube.com/watch?v=%",
        ] {
            assert_eq!(classify(url), Input::Unsupported, "{url}");
        }
    }
    #[test]
    fn accepted_video_forms_and_searches() {
        for url in [
            "https://youtube.com/watch?v=video",
            "https://youtu.be/video?t=30",
            "https://music.youtube.com/watch?v=video",
            "https://m.youtube.com/shorts/video",
            "https://youtube.com/live/video",
            "https://youtube.com/embed/video",
        ] {
            assert!(matches!(classify(url), Input::Video(_)), "{url}");
        }
        assert_eq!(classify("  Daft Punk  "), Input::Search("Daft Punk".into()));
        // Scheme-less links are search strings, matching the TypeScript
        // counterpart; callers can paste a fully-qualified URL for direct
        // resolution.
        for input in ["youtube.com/watch?v=video", "youtu.be/video"] {
            assert!(matches!(classify(input), Input::Search(_)), "{input}");
        }
        assert!(matches!(
            classify("<https://youtu.be/video>"),
            Input::Search(_)
        ));
        assert!(matches!(
            classify("MUSIC.YouTube.com/watch?v=video"),
            Input::Search(_)
        ));
    }
}
