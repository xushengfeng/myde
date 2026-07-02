// 示例: 用法
// node start.js example.js

module.exports = ({ createWindow }) => {
    createWindow({
        js: __filename, // 自身作为渲染进程脚本（仅用于演示）
        width: 800,
        height: 600,
    });
};

// 也可以直接作为渲染进程执行
if (typeof document !== 'undefined') {
    document.body.innerHTML = `
        <div style="padding:20px;font-family:system-ui">
            <h1>Hello Electron</h1>
            <p>Node: ${process.versions.node}</p>
            <p>Chrome: ${process.versions.chrome}</p>
            <p>Electron: ${process.versions.electron}</p>
        </div>`;
}
