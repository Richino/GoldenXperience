/** Enables the status-bar sampling workaround before paint, without extra padding.
 * Home Screen apps can omit Safari's Version token and freeze the OS token.
 * Use the native iOS standalone flag instead; older iOS versions can use the
 * same invisible sampling element without adding any space or painted cover.
 */
export const IOS_TOP_CLEARANCE_SCRIPT = `(function(){try{document.documentElement.classList.toggle("gx-ios-pwa-top-clearance",navigator.standalone===true);}catch(e){}})();`;
