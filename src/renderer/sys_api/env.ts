const deEnv = JSON.parse(new URLSearchParams(location.search).get("env") ?? "{}");

export function getEnv() {
    return {
        ...process.env,
        ...deEnv,
    } as Record<string, string>;
}
