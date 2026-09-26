import type { TextInputV3State } from "../module";

export function newTextInputV3State(): TextInputV3State {
    return {
        enabled: false,
        surroundingText: { text: "", cursor: 0, anchor: 0 },
        textChangeCause: "input_method",
        contentHint: 0,
        contentPurpose: 0,
        cursorRect: null,
    };
}
