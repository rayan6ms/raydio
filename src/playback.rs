use rand::seq::SliceRandom;
use serde::{Deserialize, Serialize};

pub const HISTORY_LIMIT: usize = 20;
pub const FAILURE_LIMIT: u8 = 3;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LoopMode {
    #[default]
    Off,
    Track,
    Queue,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct Track {
    pub encoded: String,
    pub identifier: String,
    pub title: String,
    pub author: String,
    pub duration_ms: u64,
    pub stream: bool,
    pub uri: Option<String>,
    pub requester_id: String,
    pub requested_by: String,
}

#[derive(Clone, Debug, Default)]
pub struct Queue {
    pub current: Option<Track>,
    pub upcoming: Vec<Track>,
    pub history: Vec<Track>,
    pub loop_mode: LoopMode,
    pub consecutive_failures: u8,
}

impl Queue {
    pub fn len(&self) -> usize {
        usize::from(self.current.is_some()) + self.upcoming.len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// Commit only already-admitted tracks. Empty loads cannot create a current track.
    pub fn enqueue(&mut self, tracks: Vec<Track>, max_tracks: usize) -> usize {
        let capacity = max_tracks.saturating_sub(self.len());
        let mut tracks = tracks.into_iter().take(capacity);
        let mut accepted = 0;
        if self.current.is_none() {
            self.current = tracks.next();
            if self.current.is_some() {
                accepted += 1;
                self.consecutive_failures = 0;
            }
        }
        for track in tracks {
            self.upcoming.push(track);
            accepted += 1;
        }
        accepted
    }
    pub fn finish(&mut self) {
        let Some(old) = self.current.take() else {
            return;
        };
        self.consecutive_failures = 0;
        if self.loop_mode == LoopMode::Track {
            self.current = Some(old);
            return;
        }
        if self.loop_mode == LoopMode::Queue {
            self.upcoming.push(old.clone());
        }
        self.remember(old);
        self.next();
    }
    pub fn fail(&mut self) {
        if self.current.is_none() {
            return;
        }
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        if self.consecutive_failures >= FAILURE_LIMIT {
            self.upcoming.clear();
            self.current = None;
        } else {
            self.next();
        }
    }
    /// Explicit skip bypasses loop mode; only a natural end repeats.
    pub fn skip(&mut self) {
        let Some(old) = self.current.take() else {
            return;
        };
        self.remember(old);
        self.next();
    }
    pub fn previous(&mut self) -> bool {
        if self.current.is_none() {
            return false;
        }
        let Some(previous) = self.history.pop() else {
            return false;
        };
        if self.loop_mode == LoopMode::Queue
            && let Some(index) = self.upcoming.iter().rposition(|track| {
                track.encoded == previous.encoded && track.requester_id == previous.requester_id
            })
        {
            self.upcoming.remove(index);
        }
        if let Some(current) = self.current.take() {
            self.upcoming.insert(0, current);
        }
        self.current = Some(previous);
        true
    }
    pub fn jump(&mut self, position: usize) -> bool {
        if self.current.is_none() {
            return false;
        }
        let Some(target) = self.remove(position) else {
            return false;
        };
        if let Some(old) = self.current.take() {
            self.remember(old);
        }
        self.current = Some(target);
        true
    }
    pub fn stop(&mut self) {
        self.current = None;
        self.upcoming.clear();
        self.history.clear();
        self.consecutive_failures = 0;
    }
    pub fn clear(&mut self) -> usize {
        let len = self.upcoming.len();
        self.upcoming.clear();
        len
    }
    pub fn shuffle(&mut self) -> bool {
        if self.upcoming.len() < 2 {
            return false;
        }
        self.upcoming.shuffle(&mut rand::rng());
        true
    }
    pub fn remove(&mut self, position: usize) -> Option<Track> {
        (position > 0 && position <= self.upcoming.len())
            .then(|| self.upcoming.remove(position - 1))
    }
    pub fn move_to(&mut self, from: usize, to: usize) -> Option<&Track> {
        if from == 0 || to == 0 || from > self.upcoming.len() || to > self.upcoming.len() {
            return None;
        }
        let track = self.upcoming.remove(from - 1);
        self.upcoming.insert(to - 1, track);
        self.upcoming.get(to - 1)
    }
    fn next(&mut self) {
        self.current = if self.upcoming.is_empty() {
            None
        } else {
            Some(self.upcoming.remove(0))
        };
    }
    fn remember(&mut self, track: Track) {
        self.history.push(track);
        if self.history.len() > HISTORY_LIMIT {
            self.history.remove(0);
        }
    }
}

pub fn format_duration(ms: u64, stream: bool) -> String {
    if stream {
        return "LIVE".into();
    }
    let seconds = ms / 1000;
    let h = seconds / 3600;
    let m = (seconds % 3600) / 60;
    let s = seconds % 60;
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn track(id: usize) -> Track {
        Track {
            encoded: id.to_string(),
            identifier: id.to_string(),
            title: id.to_string(),
            author: "a".into(),
            duration_ms: 1000,
            stream: false,
            uri: None,
            requester_id: "1".into(),
            requested_by: "u".into(),
        }
    }
    fn queue(count: usize) -> Queue {
        let mut q = Queue::default();
        q.enqueue((0..count).map(track).collect(), 1000);
        q
    }
    #[test]
    fn empty_enqueue_is_harmless() {
        let mut q = Queue::default();
        assert_eq!(q.enqueue(vec![], 10), 0);
        assert!(q.is_empty());
    }
    #[test]
    fn current_counts_towards_admission_limit() {
        let mut q = queue(2);
        assert_eq!(q.enqueue(vec![track(2), track(3)], 3), 1);
        assert_eq!(q.len(), 3);
    }
    #[test]
    fn natural_end_records_history_but_track_loop_does_not() {
        let mut q = queue(2);
        q.loop_mode = LoopMode::Track;
        q.finish();
        assert_eq!(q.current, Some(track(0)));
        assert!(q.history.is_empty());
        q.loop_mode = LoopMode::Off;
        q.finish();
        assert_eq!(q.current, Some(track(1)));
        assert_eq!(q.history, [track(0)]);
    }
    #[test]
    fn previous_undoes_queue_loop_duplication() {
        let mut q = queue(2);
        q.loop_mode = LoopMode::Queue;
        q.finish();
        assert_eq!(q.upcoming, [track(0)]);
        assert!(q.previous());
        assert_eq!(q.current, Some(track(0)));
        assert_eq!(q.upcoming, [track(1)]);
        assert!(q.history.is_empty());
    }
    #[test]
    fn skip_bypasses_all_loops() {
        for mode in [LoopMode::Off, LoopMode::Track, LoopMode::Queue] {
            let mut q = queue(2);
            q.loop_mode = mode;
            q.skip();
            assert_eq!(q.current, Some(track(1)));
            assert!(q.upcoming.is_empty());
        }
    }
    #[test]
    fn jump_preserves_other_upcoming_tracks() {
        let mut q = queue(4);
        assert!(q.jump(2));
        assert_eq!(q.current, Some(track(2)));
        assert_eq!(q.upcoming, [track(1), track(3)]);
        assert_eq!(q.history, [track(0)]);
    }
    #[test]
    fn failures_stop_at_three_without_recording_failed_history() {
        let mut q = queue(6);
        q.fail();
        q.fail();
        assert_eq!(q.current, Some(track(2)));
        q.fail();
        assert!(q.is_empty());
        assert!(q.history.is_empty());
    }
    #[test]
    fn success_resets_failure_streak() {
        let mut q = queue(6);
        q.fail();
        q.fail();
        q.finish();
        q.fail();
        assert!(q.current.is_some());
        assert_eq!(q.consecutive_failures, 1);
    }
    #[test]
    fn bounded_history_and_stop_reset() {
        let mut q = queue(50);
        for _ in 0..30 {
            q.finish();
        }
        assert_eq!(q.history.len(), HISTORY_LIMIT);
        assert_eq!(q.history[0], track(10));
        q.stop();
        assert!(q.is_empty());
        assert!(q.history.is_empty());
    }
    #[test]
    fn positions_are_one_based_and_invalid_operations_are_inert() {
        let mut q = queue(3);
        assert_eq!(q.remove(0), None);
        assert_eq!(q.move_to(1, 3), None);
        assert_eq!(q.move_to(1, 2).unwrap(), &track(1));
        assert_eq!(q.upcoming, [track(2), track(1)]);
        assert!(!q.jump(3));
    }
    #[test]
    fn durations_are_stable() {
        assert_eq!(format_duration(3723000, false), "1:02:03");
        assert_eq!(format_duration(0, true), "LIVE");
    }
}
