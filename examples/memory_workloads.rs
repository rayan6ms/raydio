//! Deterministic production-code allocation workloads; no Discord or source network.
use raydio::{
    playback::{Queue, Track},
    resolver::{self, Limits},
    views,
    voice::{Cache, Guild},
};
use serde_json::json;
use std::{
    alloc::{GlobalAlloc, Layout, System},
    hint::black_box,
    sync::atomic::{AtomicUsize, Ordering::Relaxed},
    time::Instant,
};
use twilight_model::{
    channel::Channel,
    gateway::{event::Event, payload::incoming::ChannelCreate},
};

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static CALLS: AtomicUsize = AtomicUsize::new(0);
static BYTES: AtomicUsize = AtomicUsize::new(0);
fn allocated(n: usize) {
    CALLS.fetch_add(1, Relaxed);
    BYTES.fetch_add(n, Relaxed);
    PEAK.fetch_max(LIVE.fetch_add(n, Relaxed) + n, Relaxed);
}
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            allocated(l.size());
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        LIVE.fetch_sub(l.size(), Relaxed);
        unsafe { System.dealloc(p, l) };
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        let result = unsafe { System.realloc(p, l, n) };
        if !result.is_null() {
            LIVE.fetch_sub(l.size(), Relaxed);
            allocated(n);
        }
        result
    }
}
#[global_allocator]
static ALLOCATOR: Counting = Counting;

fn measure<T>(name: &str, iterations: usize, f: impl FnOnce() -> T) -> T {
    let base = LIVE.load(Relaxed);
    PEAK.store(base, Relaxed);
    CALLS.store(0, Relaxed);
    BYTES.store(0, Relaxed);
    let at = Instant::now();
    let result = black_box(f());
    let elapsed = at.elapsed().as_nanos();
    let heap_end = LIVE.load(Relaxed);
    let heap_peak = PEAK.load(Relaxed);
    let live = LIVE.load(Relaxed).saturating_sub(base);
    let peak = PEAK.load(Relaxed).saturating_sub(base);
    let calls = CALLS.load(Relaxed);
    let bytes = BYTES.load(Relaxed);
    println!(
        "{}",
        json!({"workload":name,"iterations":iterations,"elapsedNs":elapsed,"retainedBytes":live,"heapAtStartBytes":base,"heapAtEndBytes":heap_end,"peakHeapBytes":heap_peak,"peakExtraBytes":peak,"allocationCalls":calls,"allocatedBytes":bytes})
    );
    result
}

fn main() {
    let events: Vec<_> = (1..=100).flat_map(|guild| (1..=50).map(move |number| {
        let channel: Channel = serde_json::from_value(json!({
            "id":(guild * 100 + number).to_string(),"guild_id":guild.to_string(),
            "type":if number <= 10 {2} else {0},"name":format!("channel-{number}"),
            "topic":"A channel topic with links and discussion guidelines.".repeat(4),
            "user_limit":10,"permission_overwrites":[{"id":guild.to_string(),"type":0,"allow":"1049600","deny":"0"}]
        })).unwrap();
        Event::ChannelCreate(Box::new(ChannelCreate(channel)))
    })).collect();
    let cache = measure("channel_cache_100_guilds_5000_channels", 5000, || {
        let mut cache = Cache::default();
        for id in 1..=100 {
            cache.guilds.insert(id, Guild::default());
        }
        for event in &events {
            cache.update(event, 9);
        }
        cache
    });
    drop(cache);
    drop(events);
    for trial in 0..5 {
        let raw = json!({"loadType":"playlist","data":{"info":{"name":"Benchmark playlist"},"tracks":(0..1000).map(|n| json!({
            "encoded":"a".repeat(400),"info":{"identifier":format!("video{n}"),"title":"Benchmark track title","author":"Benchmark channel","length":180000,"isStream":false,"uri":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","sourceName":"youtube"},"pluginInfo":{},"userData":{}}
        )).collect::<Vec<_>>()}});
        let result = measure(&format!("playlist_1000_trial_{trial}"), 1000, || {
            resolver::normalize(raw, true, false, 1000, &Limits::default()).unwrap()
        });
        assert_eq!(result.tracks.len(), 250);
        assert_eq!(result.omitted, 750);
        drop(result);
    }
    let mut queue = Queue::default();
    queue.enqueue(
        vec![Track {
            encoded: "t".into(),
            identifier: "dQw4w9WgXcQ".into(),
            title: "Never Gonna Give You Up".into(),
            author: "Rick Astley".into(),
            duration_ms: 213000,
            stream: false,
            uri: Some("https://www.youtube.com/watch?v=dQw4w9WgXcQ".into()),
            requester_id: "1".into(),
            requested_by: "Listener".into(),
        }],
        1000,
    );
    for trial in 0..5 {
        measure(&format!("player_render_trial_{trial}"), 10000, || {
            for i in 0..10000 {
                black_box(views::player(&queue, "session", i % 2 == 0, 70, i * 20));
            }
        });
    }
    // Golden output is emitted for semantic differential checking across builds.
    let view = views::player(&queue, "session", false, 70, 12000);
    println!(
        "{}",
        json!({"goldenPlayer":{"content":view.content,"embeds":view.embeds,"components":view.components}})
    );
    // Paired cache model: the exact pre-change retained Track representation
    // and the current production choice conversion, with identical inputs/TTL.
    // This does not simulate Discord network traffic or claim whole-bot PSS.
    let mut track = queue.current.unwrap();
    track.encoded = "a".repeat(400);
    let tracks = vec![track; 10];
    let before = measure("autocomplete_legacy_500_queries", 500, || {
        let mut cache = std::collections::HashMap::new();
        for n in 0..500 {
            cache.insert(format!("query-{n}"), (Instant::now(), tracks.clone()));
        }
        cache
    });
    measure("autocomplete_legacy_10000_hits", 10000, || {
        for _ in 0..10000 {
            black_box(views::search_choices(before["query-0"].1.clone()));
        }
    });
    let expected = views::search_choices(before["query-0"].1.clone());
    drop(before);
    let after = measure("autocomplete_choices_500_queries", 500, || {
        let mut cache = std::collections::HashMap::new();
        for n in 0..500 {
            let choices = views::search_choices(tracks.clone());
            cache.insert(format!("query-{n}"), (Instant::now(), choices.clone()));
        }
        cache
    });
    assert_eq!(expected, after["query-0"].1);
    measure("autocomplete_choices_10000_hits", 10000, || {
        for _ in 0..10000 {
            black_box(after["query-0"].1.clone());
        }
    });
}
