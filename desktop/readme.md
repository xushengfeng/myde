# 默认桌面

## 开发提示

使用不了`require`，如果有复杂计算任务，使用 woker+wasm，如果需要其他系统 api，需要修改引擎，请提交 issuse 或 pr。

不建议使用网络加载外部内容。

避免复杂循环导致页面卡死，必要时添加`await scheduler.yield()`。

不使用 css 的`cursor`属性，需要自己实现光标

不使用 title 属性，或者借助 title 实现自己的 tooltip
