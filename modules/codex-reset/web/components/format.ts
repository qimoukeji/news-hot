import { typeName as monitorTypeName } from "../../../reset-monitor/web/components/format.ts";
import { definition } from "../../definition.ts";
export { bjDate, bjTime, dayWord, windowText, durationText, stamp } from "../../../reset-monitor/web/components/format.ts";

export const typeName = (type: "direct_reset" | "reset_credit") => monitorTypeName(type, definition.product);
