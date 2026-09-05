use crate::{
    playback::{LoopMode, Queue, Track, format_duration},
    urls::valid_identifier,
};
use serde::Deserialize;
use serde_json::{Value, json};
use twilight_model::channel::message::{Component, Embed};

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct View {
    pub content: Option<String>,
    #[serde(default)]
    pub embeds: Vec<Embed>,
    #[serde(default)]
    pub components: Vec<Component>,
}
impl View {
    pub fn text(text: impl AsRef<str>) -> Self {
        Self {
            content: Some(truncate(text.as_ref(), 2000)),
            ..Self::default()
        }
    }
    fn json(value: Value) -> Self {
        serde_json::from_value(value).expect("checked Discord view shape")
    }
}

pub fn truncate(text: &str, max: usize) -> String {
    if text.encode_utf16().count() <= max {
        return text.into();
    }
    let mut count = 0;
    let mut result = String::new();
    for character in text.chars() {
        if count + character.len_utf16() >= max {
            break;
        }
        result.push(character);
        count += character.len_utf16();
    }
    if max > 0 {
        result.push('…');
    }
    result
}
pub fn safe(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut result = String::new();
    for c in flat.chars() {
        if "\\*_~`|>[]()#".contains(c) {
            result.push('\\');
        }
        if !c.is_control() {
            result.push(c);
        }
    }
    truncate(&result, max)
}
fn label(mode: LoopMode) -> &'static str {
    if mode == LoopMode::Off {
        "Loop: OFF"
    } else {
        "Loop: ON"
    }
}
pub fn mode_name(mode: LoopMode) -> &'static str {
    match mode {
        LoopMode::Off => "off",
        LoopMode::Track => "track",
        LoopMode::Queue => "queue",
    }
}
fn button(
    session: &str,
    action: &str,
    label: &str,
    emoji: &str,
    style: u8,
    disabled: bool,
) -> Value {
    json!({"type":2,"style":style,"custom_id":format!("raydio:player:{session}:{action}"),"label":label,"emoji":{"name":emoji},"disabled":disabled})
}

pub fn player(queue: &Queue, session: &str, paused: bool, volume: u16, position: u64) -> View {
    let Some(track) = &queue.current else {
        return View::text("Nothing is playing.");
    };
    let progress = if track.stream {
        "🔴 **LIVE**".to_owned()
    } else {
        let marker = if track.duration_ms == 0 {
            0
        } else {
            ((position.min(track.duration_ms) as u128 * 30 / track.duration_ms as u128) as usize)
                .min(29)
        };
        let bar: String = (0..30)
            .map(|index| if index == marker { '●' } else { '━' })
            .collect();
        format!(
            "{bar}\n`{} / {}`",
            format_duration(position.min(track.duration_ms), false),
            format_duration(track.duration_ms, false)
        )
    };
    let mut embed = json!({"type":"rich","color":0x8b5cf6,"author":{"name":"Raydio • Now Playing"},"title":safe(&track.title,200),"description":progress,"fields":[
        {"name":"Channel","value":safe(&track.author,100),"inline":true},
        {"name":"Requested by","value":safe(&track.requested_by,64),"inline":true},
        {"name":"Up next","value":queue.upcoming.first().map(|t|safe(&t.title,200)).unwrap_or_else(||"Nothing queued".into()),"inline":true},
        {"name":"Volume","value":format!("{volume}%"),"inline":true}
    ],"footer":{"text":format!("{} • {} • refreshes every second",if paused {"Paused"} else {"Playing"}, label(queue.loop_mode))}});
    if valid_identifier(&track.identifier) {
        embed["thumbnail"] =
            json!({"url":format!("https://i.ytimg.com/vi/{}/hqdefault.jpg",track.identifier)});
    }
    if let Some(uri) = &track.uri
        && let Ok(url) = url::Url::parse(uri)
        && url.scheme() == "https"
        && matches!(
            url.host_str(),
            Some("youtube.com" | "www.youtube.com" | "music.youtube.com" | "youtu.be")
        )
        && url.username().is_empty()
        && url.password().is_none()
    {
        embed["url"] = json!(url.as_str());
    }
    View::json(json!({"content":null,"embeds":[embed],"components":[
        {"type":1,"components":[button(session,"previous","Previous","⏮️",2,queue.history.is_empty()),button(session,"pause",if paused {"Resume"} else {"Pause"},if paused {"▶️"} else {"⏸️"},1,false),button(session,"skip","Next","⏭️",2,queue.upcoming.is_empty()),button(session,"stop","Stop","⏹️",4,false)]},
        {"type":1,"components":[button(session,"queue","Queue","📋",2,false),button(session,"loop",label(queue.loop_mode),"🔁",2,false),button(session,"leave","Leave","👋",4,false)]}
    ]}))
}
fn compact(track: &Track) -> String {
    format!(
        "**{}** — {} [{}] • {}",
        safe(&track.title, 60),
        safe(&track.author, 30),
        format_duration(track.duration_ms, track.stream),
        safe(&track.requested_by, 24)
    )
}
pub fn queue(
    queue: &Queue,
    session: &str,
    requested_page: usize,
    paused: bool,
    volume: u16,
    position: u64,
) -> View {
    let Some(current) = &queue.current else {
        return View::text("The queue is empty.");
    };
    let pages = queue.upcoming.len().div_ceil(10).max(1);
    let page = requested_page.min(pages - 1);
    let progress = if current.stream {
        "LIVE".into()
    } else {
        format!(
            "{} elapsed • {} remaining",
            format_duration(position.min(current.duration_ms), false),
            format_duration(current.duration_ms.saturating_sub(position), false)
        )
    };
    let mut lines = vec![
        format!("Now playing: {}", compact(current)),
        format!("Progress: {progress}"),
    ];
    if queue.upcoming.is_empty() {
        lines.push("Upcoming: empty".into());
    } else {
        lines.push(format!("Upcoming • Page {}/{}:", page + 1, pages));
        for (index, track) in queue.upcoming.iter().enumerate().skip(page * 10).take(10) {
            lines.push(format!("{}. {}", index + 1, compact(track)));
        }
    }
    let mut time = if current.stream {
        0
    } else {
        current.duration_ms.saturating_sub(position)
    };
    let mut streams = usize::from(current.stream);
    for track in &queue.upcoming {
        if track.stream {
            streams += 1;
        } else {
            time = time.saturating_add(track.duration_ms);
        }
    }
    lines.push(format!(
        "Finite queue time remaining: {}{}",
        format_duration(time, false),
        if streams > 0 {
            format!(" • {streams} live not included")
        } else {
            String::new()
        }
    ));
    lines.push(format!(
        "Status: {} • Loop: {} • Volume: {volume}%",
        if paused { "paused" } else { "playing" },
        mode_name(queue.loop_mode)
    ));
    let components = if pages > 1 {
        json!([{"type":1,"components":[
            {"type":2,"style":2,"label":"Previous","custom_id":format!("raydio:queue:{session}:{}",page.saturating_sub(1)),"disabled":page==0},
            {"type":2,"style":2,"label":"Next","custom_id":format!("raydio:queue:{session}:{}",(page+1).min(pages-1)),"disabled":page+1==pages}
        ]}])
    } else {
        json!([])
    };
    View::json(
        json!({"content":truncate(&lines.join("\n"),2000),"embeds":[],"components":components}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf16_limits_do_not_split_emoji() {
        assert_eq!(truncate("😀😀a", 4), "😀…");
        assert_eq!(truncate("hello", 1), "…");
    }
    #[test]
    fn inactive_panels_have_no_controls() {
        assert!(
            player(&Queue::default(), "id", false, 70, 0)
                .components
                .is_empty()
        );
        assert!(
            queue(&Queue::default(), "id", 0, false, 70, 0)
                .components
                .is_empty()
        );
    }
    #[test]
    fn metadata_cannot_introduce_markdown_links() {
        assert_eq!(
            safe("[click](https://evil.invalid)", 100),
            "\\[click\\]\\(https://evil.invalid\\)"
        );
    }
    #[test]
    fn player_keeps_seven_controls_and_thumbnail() {
        let mut q = Queue::default();
        q.enqueue(
            vec![Track {
                encoded: "t".into(),
                identifier: "video".into(),
                title: "Song".into(),
                author: "Channel".into(),
                duration_ms: 1000,
                stream: false,
                uri: None,
                requester_id: "1".into(),
                requested_by: "Listener".into(),
            }],
            10,
        );
        let view = player(&q, "session", false, 70, 500);
        assert_eq!(view.embeds.len(), 1);
        assert_eq!(view.components.len(), 2);
        assert_eq!(
            view.embeds[0].thumbnail.as_ref().unwrap().url,
            "https://i.ytimg.com/vi/video/hqdefault.jpg"
        );
        let data = serde_json::to_value(view.components).unwrap();
        assert_eq!(
            data[0]["components"].as_array().unwrap().len()
                + data[1]["components"].as_array().unwrap().len(),
            7
        );
    }
}
