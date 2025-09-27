export interface setting {
    firstRun: boolean;
    settingVersion: string;

    lan: string;

    appearance: {
        theme: "system" | "light" | "dark";
        size: {
            normal: {
                w: number;
                h: number;
                m: boolean;
            };
        };
    };

    searchEngine: {
        default: string;
        engine: {
            [name: string]: {
                des: string;
                img: string;
                url: string;
                sug: string;
                from: "opensearch" | "user";
            };
        };
    };

    windows: {
        // 桌面背景
        desktop: {
            screenId: number;
            id: string;
            url: string;
        }[];
        // 小组件
        fixed: {
            id: string;
            left: string; // css单位
            top: string; // css单位
            width: string; // css单位
            height: string; // css单位
            root: number | null; // 相对屏幕
            onTop: boolean;
            url: string;
        }[];
    };
}

/** BrowserWindow id */
type bwin_id = number & { readonly __tag: unique symbol };
// 一个browserview对应一个id，不存在history
/** 网页id（包括在同一页面跳转的） */
type view_id = number & { readonly __tag: unique symbol };
/** 访问id 包括新建、重启、刷新 */
type VisitId = number & { readonly __tag: unique symbol };

type treeItem = {
    url: string;
    title: string;
    logo: string;
    parent: view_id;
    next?: view_id[];
    visits: number[];
};

type viewAction = {
    version?: string;
    viewId: view_id;
    ignoreBid?: bwin_id;
    actionId: number;
} & (
    | { type: "close" | "reload" | "stop" | "restart" | "focus" | "dev" }
    | {
          type: "update";
          data: cardData;
      }
);

export interface cardData {
    url?: string;
    title?: string;
    icon?: string;
    cover?: string;
    loading?: boolean;
}

export interface DownloadItem {
    id: number | string;
    url: string;
    filename: string;
    status: "pending" | "downloading" | "completed";
    createdAt: number;
}
