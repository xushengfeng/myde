function list(pel: HTMLElement, height: number, gap: number, list: any[], render: (list: any) => HTMLElement) {
    const div = document.createElement("div");
    function cal() {
        const top = pel.scrollTop;
        const bottom = top + pel.offsetHeight;

        let start = 0;
        let end = 0;
        start = Math.floor((top - gap / 2) / (height + gap));
        end = Math.ceil((bottom + gap / 2) / (height + gap));

        div.innerHTML = "";
        for (let i = start; i <= end; i++) {
            if (!list[i]) continue;
            const el = render(list[i]);
            div.append(el);
            el.style.height = `${i * (height + gap)}px`;
        }
    }
    cal();
    pel.append(div);
    div.style.height = `${list.length * (height + gap) - gap}px`;
    pel.onscroll = cal;
}

export default list;
