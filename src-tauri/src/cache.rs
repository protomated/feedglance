use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

use crate::youtrack::{StateBundleElement, TeamMember, YouTrackClient};

/// TTL for cached project metadata (1 hour).
const CACHE_TTL: Duration = Duration::from_secs(3600);

#[derive(Debug, Clone)]
struct CacheEntry<T: Clone> {
    data: T,
    fetched_at: Instant,
}

impl<T: Clone> CacheEntry<T> {
    fn is_fresh(&self) -> bool {
        self.fetched_at.elapsed() < CACHE_TTL
    }
}

/// In-memory cache for project metadata (states, team members).
pub struct ProjectCache {
    states: HashMap<String, CacheEntry<Vec<StateBundleElement>>>,
    teams: HashMap<String, CacheEntry<Vec<TeamMember>>>,
}

impl ProjectCache {
    pub fn new() -> Self {
        Self {
            states: HashMap::new(),
            teams: HashMap::new(),
        }
    }
}

pub type SharedProjectCache = Arc<RwLock<ProjectCache>>;

/// Fetch project states — always hits the API but caches for reuse within TTL.
pub async fn fetch_project_states(
    cache: &SharedProjectCache,
    client: &YouTrackClient,
    project_id: &str,
) -> Result<Vec<StateBundleElement>, String> {
    // Check cache first
    {
        let c = cache.read().await;
        if let Some(entry) = c.states.get(project_id) {
            if entry.is_fresh() {
                return Ok(entry.data.clone());
            }
        }
    }

    // Fetch fresh
    let states = client
        .get_project_states(project_id)
        .await
        .map_err(|e| e.to_string())?;

    // Update cache
    {
        let mut c = cache.write().await;
        c.states.insert(
            project_id.to_string(),
            CacheEntry {
                data: states.clone(),
                fetched_at: Instant::now(),
            },
        );
    }

    Ok(states)
}

/// Fetch project team — always hits the API but caches for reuse within TTL.
pub async fn fetch_project_team(
    cache: &SharedProjectCache,
    client: &YouTrackClient,
    project_id: &str,
) -> Result<Vec<TeamMember>, String> {
    // Check cache first
    {
        let c = cache.read().await;
        if let Some(entry) = c.teams.get(project_id) {
            if entry.is_fresh() {
                return Ok(entry.data.clone());
            }
        }
    }

    // Fetch fresh
    let members = client
        .get_project_team(project_id)
        .await
        .map_err(|e| e.to_string())?;

    // Update cache
    {
        let mut c = cache.write().await;
        c.teams.insert(
            project_id.to_string(),
            CacheEntry {
                data: members.clone(),
                fetched_at: Instant::now(),
            },
        );
    }

    Ok(members)
}
