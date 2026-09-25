export type ApiQuery = Record<string, unknown>;

/** Build an API URL while preserving existing query fields and base-path prefixes. */
export function apiRequestUrl(baseUrl: string, path: string, query: ApiQuery = {}, directory?: string) {
  const question = path.indexOf("?");
  const route = question < 0 ? path : path.slice(0, question);
  const params = new URLSearchParams(question < 0 ? "" : path.slice(question + 1));
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) params.set(name, String(value));
  }
  if (directory) params.set("directory", directory);
  const search = params.toString();
  return `${baseUrl.replace(/\/+$/, "")}${route}${search ? `?${search}` : ""}`;
}

/** Shared production request boundary, factored so URL assembly can be tested with a capture transport. */
export function fetchApi(
  transport: typeof fetch,
  baseUrl: string,
  path: string,
  query: ApiQuery,
  directory: string | undefined,
  init: RequestInit,
) {
  return transport(apiRequestUrl(baseUrl, path, query, directory), init);
}
