# 开发笔记

---

25.09.30 以前

现在才开始记笔记，但已经开发了几天。

我们没必要关心 x 的具体实现和他们的性能差异等。Wayland 的通信方式很简单。

对于 Wayland，有若干个 app，他们是客户端（client），我们开发的桌面（合成器）也叫服务端（server）。他们是用 unix socket 进行数据交互的。

我们创建了一个 socket 文件，可以理解为网址之类的，为`$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY`。服务端使用 socket 监听它，然后在启动 app 时给他们这些环境变量，他们也会通过这些来交互。

app 链接到 socket 时，socket 的 connection 事件就会返回一个 client socket，这样每个 app 与服务端的连接都是隔离的，不需要专门区分或隔离。

客户端发送到服务端的信息，为 request（请求），服务端发送回去的，为 event（事件）。

他们发送的，是类似函数的东西，比如`wl_display::get_registry`，就是名为`wl_display`的接口，和名为`get_registry`的方法（js 没有专门区分这些概念，理解为`wl_display`的 obj 包含`get_registry`函数就可以了）。以及具体的参数。

所有接口、方法和参数，就是消息包含的信息。当然，为了敏捷高效，是不会发送接口方法的字符串的，也不会发送类似 JSON 的东西，而是直接发送二进制。这些二进制就由客户端、服务端各自解析。这些解析依赖什么呢，他们是怎么知道要用什么方式解析呢？这些细节我不清楚，全部交给 ai 了。首先，对象 id、消息长度、操作码是固定位置的，可以拿到他们对应的数字。对象 id 指的就是接口，操作码是方法的索引。明确方法后，由于方法是已经定义好的，就可以根据方法参数的顺序解析后面的参数二进制，比如第一个参数是叫`registry`，他的类型是`new_id`，我们用解析 new_id 的方式去解析，然后后面的二进制就是第二个参数了（当然我举的`wl_display::get_registry`只有一个参数）。编码也是一样。

有时候解析完了还有二进制，那是因为合并多个消息一起发送了，继续当成新的解析即可。

上面提到过，方法是已经定义好的，那定义在哪里？其实就是所谓的 Wayland 协议。客户端、服务端都了解 Wayland 协议，所以各种方法都是已经定义好的。Wayland 协议用 xml 编写，定义了接口名称，各个 request，各个 event。客户端发送到服务端，是 request，所以操作码在 request 里面索引，event 也一样。我写了脚本把 xml 转成 json，方便索引解析。 https://wayland.app/protocols/ 这个网站有更直观的协议定义，不用一个个看 xml。

由于不同的客户端、服务端对 Wayland 协议支持的程度、版本各不相同，所以我们需要更灵活的方式。前面提到过对象 id 来索引接口，是如何实现的呢？前面的类型`new_id`就是关于对象 id 的。首先 id=1 表示的是 `wl_display`。客户端传来了`wl_display::get_registry(registry: new_id<wl_registry>)`，服务器就把`wl_registry`绑定到`registry`的值，也就是新的 id。这样我们有了两个对象 id 和他们各自代表的接口。服务端通过`wl_registry::global(name: uint, interface: string, version: uint)`告诉客户端我有什么接口和版本，`name`是服务端内部的索引，分多次发送。然后客户端发送`wl_registry::bind(name: uint, id: new_id)`，说`name`应该用什么 id 表示。这样服务端就会创建他们的索引（其实`name`是用在中间临时用的，节省客户端发到服务端的资源，后面都会用对象 id）。

`wl_registry::bind(name: uint, id: new_id)`信息是对象 id、消息长度、操作码、参数 name、接口名称、接口版本、参数 id，在解析时需要注意解析中间插进来的接口名称和接口版本，才能进行解析 id，否则会乱套。

还有个特殊的类型叫`fd`。是用来共享硬件资源的，比如内存。客户端渲染时，rgba 像素的信息太大，都通过 socket 直接传输很慢。所以借助了 unix socket 的辅助数据，传递大数据的 id。Linux 中可以用文件描述符（fd）指代某段内存，通过辅助数据传输 fd，Linux 会自动把 fd 转换成服务端也可以读取的 fd，服务端就可以读取 fd 所代表的内存信息了，实际传输，只传递了一个整数 id。nodejs 的 net 库不能传输 fd，所以我用`usocket`库，但无法在 Electron 上运行，我又修改了一下，并重新发布了个新包。

在开发时，设置环境变量`WAYLAND_DEBUG=1`可以显示消息互相传递的过程。`wayland-info`可以测试初始化。`weston-flower`是一个很方便的测试例。

---

25.09.30

优化了一下 sync 实现。上面说过，服务端用`wl_registry::global`多次发送数据。客户端开始时除了`wl_display::get_registry`，还发送了`wl_display::sync`，给定了一个 id，这个 id 要服务端新建一个`wl_callback`。这样，服务端发送一系列数据后，用`wl_callback::done`就可以了。

这次的优化，把接收`wl_display::sync`和发送`wl_callback::done`放在一起，并添加了`wl_display::sync`的上一个接收记录。`wl_display::get_registry`后面会跟一个`wl_display::sync`。等`global`发送完后，还会有一个 sync，可以把渲染格式、输入输出等告诉客户端。所以把这两个 sync 放在一起实现。

还有很多实现细节我不知道。这里面的很多序列处理让人困惑，要把他进行良好的封装，方便在 js 中用回调操控。由于我们要实现的是合成器服务端，接收是被动的，输入事件是可以随时主动发送的，关键是接收后发送，比如收到 sync，是需要上文信息的（不过是在一个 socket 消息中组合发送的，不知道有没有特例）。

---

25.10.01

了解到一些对象是可以存储信息的。比如`wl_shm`，可以存储`create_pool`。这样看来，服务端像是无情的存储数据库，对象的创建和释放都依赖客户端消息，这是好事啊，我们也许不用处理太多的状态，借助对象存储信息，跟着消息动就可以了。

开发时，总是先实现再优化，不管怎么说，先点亮再说。在没有了解 xdg 等协议的情况下，根据 kde 的日志，复刻的消息序列，硬编码了一些数据，最后成功显示了花朵`weston-flower`。意味着这条路走得通。当然，有项目[greenfield](https://greenfield.app/)也实现了 web 技术处理 Wayland 并显示，他需要本地处理器和 web 浏览器来实现，但现在，我们用 Electron 直接实现了，socket 传输的 fd 是可以读取的，可以显示的！

鉴于快速开发，项目就先不实现太多与系统直接交互的东西，比如输入输出、内存共享，而是先像 Weston 一样显示窗口，借助窗口的输入输出来继续开发。之前尝试过让 Electron 通过 drm 输出，可惜没成功，暂停了开发。现在我先不管这么多，先把 demo 写好，先搞好空中楼阁。当然，输入实现需要提前包装，不直接在元素上使用`on('pointerdown')`之类的。

对于绘制，可以这样类比 `wl_shm_pool`->`Uint8ClampedArray`， `wl_buffer`->`imageData`， `wl_surface`->`canvas`。`wl_surface.attach`稍微绑定了 canvas 和 imageData，后面可以有若干个`wl_surface.damage`，最后是`wl_surface.commit`，也就是`ctx.putImageData(imagedata, 0, 0, damage.x, damage.y, damage.width, damage.height);`

---

25.10.02

nodejs 不支持 mmap 内存数据，所以在获取共享内存数据时，我用 fd 来充当内存指针，需要时读取。

```ts
const buffern = new Uint8ClampedArray(bufferX.data.end - bufferX.data.start);
fs.readSync(bufferX.data.fd, buffern, bufferX.data.start, buffern.length, 0);
imagedata.data.set(buffern);
```

不能直接用`fs.readFileSync`读取，会导致全是 0 的问题，用`fs.readSync`并显式标明开始位置。这里的`bufferX.data.start`其实是 offset。
