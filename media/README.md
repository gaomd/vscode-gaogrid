# Icon attribution

`icon.svg` adapts the `terminal` icon from
[@vscode/codicons](https://github.com/microsoft/vscode-codicons), by Microsoft,
licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
The terminal silhouette is filled, with the original prompt shapes cut out so
they remain visible when VS Code renders the image as a monochrome mask.

`icon.png` is a 256×256 black raster version of `icon.svg`, used for the extension
listing in VS Code and the Marketplace. Regenerate it with ImageMagick:

```sh
sed 's/currentColor/#000000/g' media/icon.svg | \
  magick -background none -density 768 svg:- -resize 256x256 PNG32:media/icon.png
```

Webview buttons and menus also use SVG assets from `@vscode/codicons` under
the same license. Their original paths and scale are preserved; the viewBox is
centered on each icon's visible bounds for consistent alignment inside controls.

View container icons are rendered as monochrome masks by VS Code. The terminal
body is opaque; the prompt and surrounding space stay transparent.
