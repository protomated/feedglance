export interface UserInfo {
  id: string;
  login: string;
  fullName: string;
  email: string;
  avatarUrl: string;
}

export interface Credentials {
  url: string;
  token: string;
}

/** A YouTrack Cloud account with its credentials and user info. */
export interface Account {
  /** Deterministic ID derived from the normalized URL. */
  id: string;
  url: string;
  token: string;
  user: UserInfo;
  /** User-editable display name; defaults to the hostname. */
  label?: string;
}

// --- Epic 3: Quick Actions types ---

/** A state value from a project's custom field bundle. */
export interface StateBundleElement {
  id: string;
  name: string;
  isResolved: boolean;
}

/** A team member from a project. */
export interface TeamMember {
  id: string;
  login: string;
  name: string;
  avatarUrl: string;
}

/** Result of executing a command or posting a comment. */
export interface CommandResult {
  success: boolean;
  message: string;
}
