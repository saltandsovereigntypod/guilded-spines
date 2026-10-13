# Embedded fonts

Cinzel, EB Garamond and Spectral, as served by Google Fonts (every subset), so
the iPhone app looks the same with no signal. `../../build.py` inlines them into
`app/assets/web/gilded-spines.html`. All three are under the SIL Open Font
License 1.1.

To refresh them, fetch the stylesheet named in the `<link>` at the top of
`artifact/gilded-spines.html` with an iPhone Safari user agent, download each
`fonts.gstatic.com` file here (path with `/` turned into `_`), and point
`fonts.css` at the local names.
