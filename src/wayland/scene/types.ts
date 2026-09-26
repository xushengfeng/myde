/**
 * 场景层契约：把「对场景图的操作」表达成可序列化的命令，而不是方法调用。
 *
 * 与 renderTools 的三点差别：
 *   1. 不带画布 —— 像素走 ImageKV（OffscreenCanvas 不可序列化）
 *   2. 不带 cursor —— cursor 是语义状态，走 ServerEvents
 *   3. 不带回调   —— 桌面事件走 ServerEvents，不在场景通道里绕回
 *
 * 本地（render_tools_el）、远程（remote）、mock 消费同一份命令，
 * 加一个 op 会由编译器把所有消费者标出来，不会漏实现。
 */

/** 图像在 ImageKV 中的引用；命令只带引用，不内联像素 */
export type ImageRef = string;

export type SceneCmd =
    /** 绑定 surface，建出场景节点 */
    | { op: "bind"; sid: string }
    /** 内容变化；像素已进 ImageKV，这里只带 key */
    | { op: "render"; sid: string; image: ImageRef }
    | { op: "destroy"; sid: string }
    /** subsurface / popup 的父子关系 */
    | { op: "anchor"; sid: string; parent?: string }
    | { op: "offset"; sid: string; x: number; y: number }
    | { op: "bufferOffset"; sid: string; x: number; y: number }
    | { op: "xdgEle"; sid: string; kind: "create" | "destroy"; role?: "toplevel" | "popup" }
    | { op: "xdgGeo"; sid: string; w: number; h: number; ox: number; oy: number }
    | { op: "toplevel"; sid: string }
    | { op: "popup"; child: string; parent: string; x?: number; y?: number };

/**
 * 图像通道：协议产生像素的地方写入，渲染侧读取，远程经 onPut 推 bytes。
 * 与 SceneCmd 分离是远程的硬需求 —— 命令是纯值，图像不是。
 */
export interface ImageKV {
    put(key: ImageRef, img: OffscreenCanvas | Uint8Array): void;
    get(key: ImageRef): OffscreenCanvas | Uint8Array | undefined;
    /** 远程同步源：新增图像时推送（Uint8Array 形态） */
    onPut(cb: (key: ImageRef, img: Uint8Array) => void): () => void;
    /** 引用计数归零或 surface 销毁时回收 */
    release(key: ImageRef): void;
}
