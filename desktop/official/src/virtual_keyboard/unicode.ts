/** Unicode 页的常用字符分组；分组只是展示顺序，用户可以另外输入任意码位。 */
export interface UnicodeGroup {
    id: string;
    name: string;
    chars: string[];
}

export const UNICODE_GROUPS: UnicodeGroup[] = [
    {
        id: "punctuation",
        name: "标点",
        chars: [..."“”‘’«»‹›–—…·•‰′″§¶©®™"],
    },
    {
        id: "math",
        name: "数学",
        chars: [..."±×÷≠≈≤≥∞√∑∏∫∈∉∋⊂⊃⊆⊇∪∩∀∃∄∵∴∂∇∝∅"],
    },
    {
        id: "arrow",
        name: "箭头",
        chars: [..."←↑→↓↔↕⇐⇑⇒⇓⇔⇕↖↗↘↙↺↻⟲⟳⇄⇅⇆⇇⇈⇉⇊"],
    },
    {
        id: "currency",
        name: "货币",
        chars: [..."$¢£€¥₩₽₹₺₴₦₱฿₿₡₭₮₲₵₸"],
    },
    {
        id: "latin",
        name: "拉丁扩展",
        chars: [..."ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØŒÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøœùúûüýþÿ"],
    },
    {
        id: "greek",
        name: "希腊",
        chars: [..."ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψω"],
    },
    {
        id: "box",
        name: "制表",
        chars: [..."─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬╭╮╯╰"],
    },
    {
        id: "geometry",
        name: "几何",
        chars: [..."■□▪▫◼◻▲△▼▽◆◇○●◎◉★☆✦✧◈◊"],
    },
    {
        id: "fraction",
        name: "数字",
        chars: [..."½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞¹²³⁰⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉"],
    },
    {
        id: "misc",
        name: "杂项",
        chars: [..."☀☁☂☃☄★☎☏☕☘☠☢☣☮☯☸☹☺♠♣♥♦♨♻♼♽⚐⚑⚖⚗⚙⚚⚛⚜⚠⚡⚰⚱⚽⚾⛄⛅⛎⛔⛪⛲⛳⛵⛺⛽"],
    },
    {
        id: "letterlike",
        name: "特殊",
        chars: [..."№℡℅℉℗℘℞℠™Ω℧℩Åℬℭℯℰℱℳℴ"],
    },
];

/** 把码位格式化成 `U+1F600` 形式；非法输入返回 undefined */
export function parseCodePoint(raw: string): number | undefined {
    const text = raw.replace(/^u\+/i, "").trim();
    if (!/^[0-9a-f]{1,6}$/i.test(text)) return undefined;
    const code = Number.parseInt(text, 16);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return undefined;
    if (code >= 0xd800 && code <= 0xdfff) return undefined;
    return code;
}

export function formatCodePoint(code: number): string {
    return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

export function charOfCodePoint(code: number): string | undefined {
    try {
        return String.fromCodePoint(code);
    } catch {
        return undefined;
    }
}
