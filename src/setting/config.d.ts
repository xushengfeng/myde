type configv1 = {
    version: "0.0.1";
    "icon.theme": string;
    /** 桌面壁纸图片的绝对路径；没有设置时使用桌面自带壁纸 */
    "wallpaper.desktop"?: string;
    /** 锁屏壁纸图片的绝对路径；没有设置时使用桌面自带壁纸 */
    "wallpaper.lock"?: string;
};

export type { configv1 as nowConfig };
