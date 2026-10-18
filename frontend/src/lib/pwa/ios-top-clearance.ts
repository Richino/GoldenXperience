/** Runs in <head> before paint; iOS can report standalone=false in matchMedia.
 * Use Safari's Version token because newer iOS UAs can freeze the OS token.
 */
export const IOS_TOP_CLEARANCE_SCRIPT = `(function(){try{var n=navigator;var v=/Version\\/(\\d+)/.exec(n.userAgent||"");document.documentElement.classList.toggle("gx-ios-pwa-top-clearance",n.standalone===true&&!!v&&Number(v[1])>=27);}catch(e){}})();`;
