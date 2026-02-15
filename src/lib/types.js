"use strict";

/**
 * @typedef {Object} File
 * @property {String} id
 * @property {String} name
 * @property {String} ext
 * @property {String} type
 * @property {String} key
 * @property {Number} date
 * @property {String} checksum
 * @property {String?} origin
 * @property {Boolean?} private
 * @property {String?} password
 */

/** @typedef {"auto" | "catppuccin" | "dark" | "light" | "amoled" | "neobrutalism" | "neobrutalism-dark" | "glassmorphism" | "neumorphism" | "claymorphism" | "minimalist" | "frost"} Theme */

/**
 * @typedef {Object} UserSettings
 * @property {Boolean} appendFileExt
 * @property {Boolean} rememberFileHistory
 * @property {Boolean} fileContentDisposition
 * @property {Boolean} stripExif
 * @property {Boolean} showThumbnails
 * @property {Theme} theme
 */

export default {};
