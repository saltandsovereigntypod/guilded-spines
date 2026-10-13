// Gilded Spines on the iPhone: the whole app is the same page that runs at
// books.saltandsovereignty.com, built by ../build.py into assets/web, shown
// full screen. The shelf and its images are kept in the app's own files
// (src/storage.ts) and reach the page through src/bridge.ts.

import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';

import pageAsset from '../assets/web/gilded-spines.html';
import { handle, parseRequest } from './bridge';
import { pageWithStore, replyScript } from './inject';
import { loadLibrary } from './storage';

// The page is given this address so that it has an ordinary https origin (for
// canvas, FileReader and the like). Nothing is ever fetched from it.
const BASE_URL = 'https://books.saltandsovereignty.com/';
const INK = '#07060B';

SplashScreen.preventAutoHideAsync().catch(() => undefined);
SystemUI.setBackgroundColorAsync(INK).catch(() => undefined);

async function readPage(): Promise<string> {
  const asset = Asset.fromModule(pageAsset);
  await asset.downloadAsync();
  if (!asset.localUri) throw new Error('The shelf page is missing from the app.');
  return new File(asset.localUri).text();
}

export default function App() {
  const webRef = useRef<WebView>(null);
  const template = useRef<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Read the saved shelf each time the page is (re)loaded, so a reload after
  // iOS reclaims the web view's memory picks up every change already saved.
  const load = useCallback(async () => {
    try {
      if (!template.current) template.current = await readPage();
      setHtml(pageWithStore(template.current, loadLibrary()));
      setGeneration((g) => g + 1);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      SplashScreen.hideAsync().catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Write any pending change the moment the app leaves the screen.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        webRef.current?.injectJavaScript('window.__GILDED_NATIVE__ && window.__GILDED_NATIVE__.flush();true;');
      }
    });
    return () => sub.remove();
  }, []);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    const req = parseRequest(event.nativeEvent.data);
    if (!req) return;
    handle(req).then(
      (value) => webRef.current?.injectJavaScript(replyScript(req.id, true, value)),
      (e) => webRef.current?.injectJavaScript(replyScript(req.id, false, e instanceof Error ? e.message : String(e))),
    );
  }, []);

  // The page never navigates; anything that tries to leave opens in Safari.
  const onShouldStart = useCallback((req: ShouldStartLoadRequest) => {
    const url = req.url;
    if (url.startsWith(BASE_URL) || url.startsWith('about:') || url.startsWith('data:') || url.startsWith('blob:')) {
      return true;
    }
    if (/^(https?|mailto):/i.test(url)) Linking.openURL(url).catch(() => undefined);
    return false;
  }, []);

  if (error) {
    return (
      <View style={styles.fallback}>
        <StatusBar style="light" />
        <Text style={styles.title}>The candles would not light</Text>
        <Text style={styles.body}>{error}</Text>
        <Pressable accessibilityRole="button" onPress={load} style={styles.button}>
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      {html ? (
        <WebView
          key={generation}
          ref={webRef}
          style={styles.web}
          source={{ html, baseUrl: BASE_URL }}
          originWhitelist={['*']}
          onMessage={onMessage}
          onShouldStartLoadWithRequest={onShouldStart}
          onLoadEnd={() => SplashScreen.hideAsync().catch(() => undefined)}
          onContentProcessDidTerminate={load}
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustContentInsets={false}
          allowsBackForwardNavigationGestures={false}
          allowsLinkPreview={false}
          allowsInlineMediaPlayback
          dataDetectorTypes="none"
          setSupportMultipleWindows={false}
          keyboardDisplayRequiresUserAction={false}
          hideKeyboardAccessoryView={false}
          javaScriptCanOpenWindowsAutomatically={false}
          showsHorizontalScrollIndicator={false}
          webviewDebuggingEnabled={__DEV__}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: INK },
  web: { flex: 1, backgroundColor: INK },
  fallback: { flex: 1, backgroundColor: INK, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 },
  title: { color: '#E7C873', fontSize: 22, textAlign: 'center' },
  body: { color: '#D9CBB0', fontSize: 15, textAlign: 'center' },
  button: { borderColor: '#E7C873', borderWidth: 1, borderRadius: 8, paddingHorizontal: 20, paddingVertical: 12, minHeight: 44 },
  buttonText: { color: '#E7C873', fontSize: 16 },
});
