import { EventEmitter } from "./event-emitter";

// 方式1: 使用 type 定义（推荐，支持索引签名）
type MyEvents = {
    userLogin: [username: string, timestamp: number];
    dataUpdate: [data: { id: number; value: string }];
    error: [error: Error];
    ready: [];
};

type MyRequestEvents = {
    query: { args: [sql: string]; result: any[] };
    getUser: { args: [id: number]; result: { name: string; email: string } };
    validate: { args: [value: string]; result: boolean };
};

const emitter = new EventEmitter<MyEvents, MyRequestEvents>();

// 方式2: 直接在尖括号里定义（适合简单场景）
new EventEmitter<
    { click: [x: number, y: number]; scroll: [delta: number] },
    { fetchData: { args: [url: string]; result: any } }
>();

// 方式3: 只定义普通事件，不需要第二个泛型参数（可选）
new EventEmitter<{ message: [text: string] }>();

// ===== 使用示例 =====

emitter.on("userLogin", (username, timestamp) => {
    console.log(`User ${username} logged in at ${timestamp}`);
});

emitter.respond("query", (_sql: string) => {
    return [{ id: 1, name: "test" }];
});

async function demo() {
    const results = await emitter.request("query", "SELECT * FROM users");
    console.log(results);
}

demo();
