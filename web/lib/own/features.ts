/** Whether the service is open for publishing and for visitors' own sources, read before a recording is offered for upload. */
export interface Features {
  publishing: boolean;
  uploads: boolean;
}

export async function readFeatures(apiUrl: string, signal?: AbortSignal): Promise<Features> {
  const response = await fetch(
    `${apiUrl}/v1/features`,
    signal ? { signal, credentials: "omit" } : { credentials: "omit" },
  );
  if (!response.ok) throw new Error(`features answered ${response.status}`);
  const body = (await response.json()) as { publishing?: unknown; uploads?: unknown };
  return { publishing: body.publishing === true, uploads: body.uploads === true };
}
