const { sysApi } =
    // @ts-expect-error
    window.myde as typeof import("../../src/renderer/desktop-api");

console.log("sysApi", sysApi);

console.log("Hello from desktop/index.js");

console.log(sysApi.getDesktopEntries());
