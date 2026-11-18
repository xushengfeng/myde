import type { PortalChoice } from "./types";

/** portal 的 a(ssa(ss)s) 里单个选项 */
export type WireChoice = [id: string, label: string, options: [id: string, label: string][], initial: string];

export function parseChoice(choice: WireChoice): PortalChoice {
    return {
        id: choice[0],
        label: choice[1],
        options: choice[2].map(([id, label]) => ({ id, label })),
        initial: choice[3],
    };
}

/** 把桌面选中的值整理成 portal 的 a(ss)，非法/缺省值回落到 initial。 */
export function buildChoiceResults(choices: PortalChoice[], selected?: Record<string, string>): [string, string][] {
    return choices.map((choice) => {
        let value = selected?.[choice.id];
        const valid =
            choice.options.length === 0
                ? value === "true" || value === "false"
                : choice.options.some((option) => option.id === value);
        if (!value || !valid) {
            value = choice.initial || (choice.options[0]?.id ?? "false");
        }
        if (choice.options.length === 0 && value !== "true" && value !== "false") {
            value = "false";
        }
        return [choice.id, value];
    });
}
