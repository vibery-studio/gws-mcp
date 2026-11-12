import type { FnDef } from "../../contracts";
import { addTask } from "./add-task";
import { adsAccounts, adsReport } from "./ads";
import { analyticsProperties, analyticsReport } from "./analytics";
import { appendSheetRows } from "./append-rows";
import { calendarFindFreeSlots, calendarMove, calendarRespond, calendarShare, calendarUnshare } from "./calendar-control";
import { exportDocPdf } from "./export-pdf";
import { fillTemplate } from "./fill-template";
import { responsesToSheet } from "./responses-to-sheet";
import { inspectUrl, topPages, topQueries } from "./searchconsole";
import { sendMailWithAttachment } from "./send-mail";
import { tagmanagerContainers, tagmanagerPublish, tagmanagerWorkspaceStatus } from "./tagmanager";
import { todayAgenda } from "./today-agenda";
import { uploadDriveFile } from "./upload-file";

/**
 * Hand-written workflow helpers (send mail, agenda, append rows, export PDF, upload, add task, form responses
 * to a sheet, fill a slides template, Search Console, Analytics, Ads, calendar sharing and free slots, Tag
 * Manager). All reach Google through `ctx.call`.
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
  topQueries,
  topPages,
  inspectUrl,
  analyticsReport,
  analyticsProperties,
  adsAccounts,
  adsReport,
  calendarShare,
  calendarUnshare,
  calendarFindFreeSlots,
  calendarRespond,
  calendarMove,
  tagmanagerContainers,
  tagmanagerWorkspaceStatus,
  tagmanagerPublish,
];
