/**
 * Globals injected by the Xiumi editor inside page.evaluate() callbacks.
 * The editor is an AngularJS app, so `angular` is available on window.
 */
declare global {
  interface Window {
    angular?: any;
    UE?: any;
  }
}

export {};
