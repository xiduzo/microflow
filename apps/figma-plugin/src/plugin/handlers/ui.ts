export function setUiOptions(options: Partial<ShowUIOptions>) {
  if (options.width && options.height) {
    figma.ui.resize(options.width, options.height);
  }
}
