import type { FnDef } from "../../contracts";
import { addTask } from "./add-task";
import { appendSheetRows } from "./append-rows";
import { exportDocPdf } from "./export-pdf";
import { fillTemplate } from "./fill-template";
import { responsesToSheet } from "./responses-to-sheet";
import { sendMailWithAttachment } from "./send-mail";
import { todayAgenda } from "./today-agenda";
import { uploadDriveFile } from "./upload-file";

/**
 * Hand-written workflow helpers (send mail, agenda, append rows, export PDF, upload, add task, form responses
 * to a sheet, fill a slides template). All reach Google through `ctx.call`.
 */
export const helperFns: FnDef[] = [
  sendMailWithAttachment,
  todayAgenda,
  appendSheetRows,
  exportDocPdf,
  uploadDriveFile,
  addTask,
  responsesToSheet,
  fillTemplate,
];
