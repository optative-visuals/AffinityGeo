// Talks to the running app's local API, the same one the AffinityGeo window uses.
export interface ApiReply { status: number; body: unknown }
export type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE";
export interface ApiClient {
  request(method: ApiMethod, path: string, body?: unknown): Promise<ApiReply>;
}
