//! Read-only reproduction of the source-loading compatibility blocker.
use mantle_core::{SourceLoad, SourceManager, SourceReference};
use mantle_media::{
    YoutubeAudioSourceManager, YoutubeAuthentication, YoutubeClientKind, YoutubeSourceItem,
    YoutubeSourceOptions,
};
use serde_json::json;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    for (name, clients) in [
        ("default", YoutubeSourceOptions::default().clients),
        ("android-vr", vec![YoutubeClientKind::AndroidVr]),
        ("web", vec![YoutubeClientKind::Web]),
    ] {
        let options = YoutubeSourceOptions {
            clients,
            ..YoutubeSourceOptions::default()
        };
        let source = YoutubeAudioSourceManager::new(options, YoutubeAuthentication::default())?;
        for id in ["dQw4w9WgXcQ", "5NV6Rdv1a3I", "kJQP7kiw5Fk"] {
            let reference =
                SourceReference::new(Some(format!("https://www.youtube.com/watch?v={id}")), false);
            let start = std::time::Instant::now();
            let outcome = match source.load(&reference) {
                Ok(Some(SourceLoad::Item(YoutubeSourceItem::Track(_)))) => "track".to_owned(),
                Ok(_) => "no-track".to_owned(),
                Err(error) => format!("{error:?}"),
            };
            println!(
                "{}",
                json!({"client":name,"identifier":id,"outcome":outcome,"elapsedMs":start.elapsed().as_millis()})
            );
        }
        source.shutdown();
    }
    Ok(())
}
