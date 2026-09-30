/** Which PM backend an account talks to. */
export type ProviderKind = "youtrack" | "nifty" | "quo";

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

/** A connected account with its credentials and user info. */
export interface Account {
  /** Deterministic ID derived from the provider and its identifying key. */
  id: string;
  /**
   * YouTrack: the instance URL, required — it is the API host.
   *
   * Nifty: the workspace origin used for deep links (`{slug}.nifty.pm` or a
   * CNAME custom domain). Optional, and NOT an API host — Nifty's API lives at
   * a fixed address. Empty simply means events carry no deep link.
   *
   * Quo: the user's Quo login email. The API key is workspace-wide, so this is
   * what identifies whose inbox to show and who in-app replies are sent as.
   */
  url: string;
  token: string;
  user: UserInfo;
  /** User-editable display name; defaults to the hostname. */
  label?: string;
  /** Defaults to "youtrack" when absent, so accounts saved by older builds load. */
  provider?: ProviderKind;
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
