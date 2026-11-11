package com.cchaha.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;
import org.json.JSONObject;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
  static final String STORE = "computers_v1";
  // Package-private seams let instrumentation run entirely on disposable fixtures.
  interface Connector { ReconnectClient.Result connect(JSONObject record, String cookie); }
  interface Probe { SessionProbe.Result read(String origin, String cookie); }
  static Probe temporaryProbe = SessionProbe::read;
  static Connector connector = new ReconnectClient(new NativeTransport.Https(), new DeviceKeys(), System::currentTimeMillis)::connect;
  static java.util.function.Function<android.content.Context, WebView> browserFactory = WebView::new;
  static java.util.function.BooleanSupplier profileSupport = BrowserProfiles::supported;
  static java.util.function.Consumer<MainActivity> backgroundTask = activity -> activity.moveTaskToBack(true);
  static java.util.function.BiFunction<String, String, String> profileCookies = (profile, origin) -> BrowserProfiles.cookiesNamed(profile).getCookie(origin + "/");
  static java.util.function.BiPredicate<SharedPreferences, String> recordWriter = (store, value) -> store.edit().putString("data", value).commit();
  private static final int FILE_REQUEST = 203;
  private static final int INK = 0xff202124;
  private static final int ACCENT = 0xff292a2d;
  private static final int PAPER = 0xfffafafa;
  private static final int MUTED = 0xff74767b;
  private TextView connectingStatus;
  private Object pendingCapture;
  private Object latestCapture;
  private Object pendingBack;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final ExecutorService requests = Executors.newFixedThreadPool(3);
  private final Map<String, SessionProbe.State> states = new HashMap<>();
  private final Map<String, TextView> labels = new HashMap<>();
  private final Map<String, String> connectionProblems = new HashMap<>();
  private String linkError;
  private String linkErrorStage;
  private final Map<String, Object> checking = new HashMap<>();
  private final Map<String, Integer> failures = new HashMap<>();
  private final Map<String, Long> nextAttempt = new HashMap<>();
  private final java.util.Set<String> temporaryTrust = new java.util.HashSet<>();
  private Network lastNetwork;
  private final Map<String, RemoteUrl> pairingLinks = new HashMap<>();
  private String requestedComputer;
  private String activeId;
  private String activeProfile;
  private String restoreComputer;
  private static final class TransientConnections {
    final Map<String, RemoteUrl> links;
    final java.util.Set<String> trust;
    TransientConnections(Map<String, RemoteUrl> links, java.util.Set<String> trust) { this.links = new HashMap<>(links); this.trust = new java.util.HashSet<>(trust); }
  }
  @Override public Object onRetainNonConfigurationInstance() { return new TransientConnections(pairingLinks, temporaryTrust); }
  private ComputerRecords records;
  private SharedPreferences preferences;
  private LinearLayout root;
  private WebView browser;
  private String activeOrigin;
  private String activeName;
  private TextView browserStatus;
  private LinearLayout errorBanner;
  private ValueCallback<Uri[]> filesCallback;
  private boolean resumed;
  private ConnectivityManager connectivity;
  private final ConnectivityManager.NetworkCallback networkCallback = new ConnectivityManager.NetworkCallback() {
    @Override public void onAvailable(Network network) { handler.post(() -> availableNetwork(network)); }
    @Override public void onLost(Network network) { handler.post(() -> lostNetwork(network)); }
  };

  void availableNetwork(Network network) {
    BrowserRecoveryPolicy.Availability action = BrowserRecoveryPolicy.available(lastNetwork, network, browser != null, resumed);
    lastNetwork = network;
    // Android reports the current default network immediately after registration.
    // That initial callback and duplicate availability events are not reconnects.
    if (action == BrowserRecoveryPolicy.Availability.INVALIDATE) {
      temporaryTrust.clear();
      if (browser != null) suspendBrowser();
      else if (resumed) recoverConnection();
    } else if (action == BrowserRecoveryPolicy.Availability.REVERIFY) recoverConnection();
  }

  void lostNetwork(Network network) {
    // A late onLost for the previous Wi-Fi must not tear down the new network.
    if (!BrowserRecoveryPolicy.lostCurrentNetwork(lastNetwork, network)) return;
    lastNetwork = null;
    temporaryTrust.clear();
    suspendBrowser();
    checking.clear();
    if (resumed) refreshStatuses();
  }
  private final Runnable poll = new Runnable() {
    @Override public void run() {
      if (!resumed) return;
      refreshStatuses();
      handler.postDelayed(this, browser == null ? 15000 : 5000);
    }
  };

  @Override public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    Object retained = getLastNonConfigurationInstance();
    if (retained instanceof TransientConnections) {
      pairingLinks.putAll(((TransientConnections) retained).links);
      temporaryTrust.addAll(((TransientConnections) retained).trust);
    }
    preferences = getSharedPreferences(STORE, MODE_PRIVATE);
    try {
      records = new ComputerRecords(preferences.getString("data", "{}"));
      cleanupRemovedProfiles();
      saveRecords();
    } catch (Exception error) {
      // Never replace corrupt user state with an empty list.
      showStorageFailure();
      return;
    }
    // A recreation preserves an intentional return to the computer list. A cold
    // launch resumes the last successfully opened identity after verification.
    String restore = savedInstanceState == null ? null : savedInstanceState.getString("computerId");
    JSONObject previous = savedInstanceState == null ? records.lastComputer() : records.find(restore);
    showComputers(false);
    if (previous != null) connectComputer(previous);
    connectivity = getSystemService(ConnectivityManager.class);
    connectivity.registerDefaultNetworkCallback(networkCallback);
  }

  private void showStorageFailure() {
    TextView message = text(getString(R.string.storage_error), 18, false);
    message.setPadding(dp(24), dp(64), dp(24), dp(24));
    setContentView(message);
  }

  private boolean saveRecords() {
    boolean saved = recordWriter.test(preferences, records.serialize());
    if (!saved) toast(R.string.save_error);
    return saved;
  }

  private void createRoot() {
    root = column();
    root.setBackgroundColor(PAPER);
    root.setFitsSystemWindows(true);
    root.setOnApplyWindowInsetsListener((v, insets) -> {
      v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
      return insets.consumeSystemWindowInsets();
    });
    setContentView(root);
    root.requestApplyInsets();
  }

  void showComputers() {
    showComputers(true);
  }

  private void showComputers(boolean refresh) {
    requestedComputer = null; restoreComputer = null; connectingStatus = null;
    closeBrowser();
    createRoot();
    labels.clear();
    ScrollView scroll = new ScrollView(this);
    scroll.setFillViewport(true);
    LinearLayout content = column();
    content.setPadding(dp(24), dp(16), dp(24), dp(20));
    scroll.addView(content);
    root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));

    LinearLayout brand = row();
    ImageView icon = new ImageView(this);
    icon.setImageResource(R.drawable.ic_launcher);
    icon.setContentDescription(getString(R.string.app_name));
    brand.addView(icon, new LinearLayout.LayoutParams(dp(32), dp(32)));
    TextView wordmark = text("cc-haha", 20, true);
    wordmark.setPadding(dp(12), 0, 0, 0);
    brand.addView(wordmark, new LinearLayout.LayoutParams(0, -2, 1));
    Button help = iconButton("?", R.string.settings, v -> help());
    brand.addView(help, new LinearLayout.LayoutParams(dp(44), dp(44)));
    content.addView(brand);
    TextView heading = text(getString(R.string.computers), 28, true);
    heading.setPadding(0, dp(32), 0, dp(8));
    content.addView(heading);
    TextView subtitle = text(getString(R.string.subtitle), 14, false);
    subtitle.setTextColor(MUTED);
    content.addView(subtitle);

    if (records.computers().length() == 0) {
      LinearLayout empty = card();
      TextView title = text(getString(R.string.empty_title), 21, true);
      empty.addView(title);
      TextView body = text(getString(R.string.empty_body), 16, false);
      body.setPadding(0, dp(14), 0, dp(12));
      empty.addView(body);
      content.addView(empty, spaced());
    }
    for (int i = 0; i < records.computers().length(); i++) {
      JSONObject computer = records.computers().optJSONObject(i);
      String name = computer.optString("name");
      String id = ComputerRecords.id(computer);
      LinearLayout card = card();
      card.setContentDescription(name);
      LinearLayout top = row();
      ImageView computerIcon = new ImageView(this);
      computerIcon.setImageResource(R.drawable.ic_computer);
      computerIcon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
      LinearLayout.LayoutParams iconLayout = new LinearLayout.LayoutParams(dp(24), dp(24));
      iconLayout.rightMargin = dp(12);
      top.addView(computerIcon, iconLayout);
      TextView title = text(name, 17, true);
      title.setMaxLines(1);
      title.setEllipsize(android.text.TextUtils.TruncateAt.END);
      top.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
      Button more = iconButton("⋯", R.string.more, v -> computerMenu(v, computer));
      more.setContentDescription(getString(R.string.more) + " " + name);
      top.addView(more, new LinearLayout.LayoutParams(dp(44), dp(44)));
      card.addView(top);
      LinearLayout bottom = row();
      TextView status = text(connectionProblems.getOrDefault(id, statusText(states.getOrDefault(id, ComputerRecords.isBound(computer) ? SessionProbe.State.CHECKING : SessionProbe.State.LEGACY))), 13, false);
      status.setTextColor(MUTED);
      labels.put(id, status);
      bottom.addView(status, new LinearLayout.LayoutParams(0, -2, 1));
      bottom.addView(button(R.string.connect, false, v -> connectComputer(computer)), new LinearLayout.LayoutParams(-2, dp(44)));
      card.addView(bottom);
      content.addView(card, spaced());
    }
    TextView hint = text(getString(R.string.connection_hint), 12, false);
    hint.setTextColor(MUTED);
    hint.setPadding(0, dp(24), 0, dp(12));
    content.addView(hint);
    LinearLayout footer = column();
    footer.setPadding(dp(24), dp(8), dp(24), dp(16));
    footer.addView(button(R.string.scan, true, v -> scan()));
    LinearLayout secondary = row();
    secondary.addView(button(R.string.paste, false, v -> paste()), new LinearLayout.LayoutParams(0, dp(52), 1));
    secondary.addView(button(R.string.refresh, false, v -> recoverConnection()), new LinearLayout.LayoutParams(0, dp(52), 1));
    LinearLayout.LayoutParams secondaryLayout = new LinearLayout.LayoutParams(-1, -2);
    secondaryLayout.topMargin = dp(8);
    footer.addView(secondary, secondaryLayout);
    root.addView(footer);
    if (refresh) refreshStatuses();
  }

  private void computerMenu(View anchor, JSONObject computer) {
    String origin = computer.optString("origin");
    PopupMenu menu = new PopupMenu(this, anchor);
    menu.getMenu().add(R.string.rename).setOnMenuItemClickListener(item -> { rename(computer); return true; });
    menu.getMenu().add(R.string.copy_link).setOnMenuItemClickListener(item -> { copy(origin); return true; });
    menu.getMenu().add(R.string.remove).setOnMenuItemClickListener(item -> {
      new AlertDialog.Builder(this).setTitle(R.string.remove).setMessage(R.string.remove_body)
        .setNegativeButton(R.string.cancel, null).setPositiveButton(R.string.remove, (dialog, which) -> {
          removeComputer(computer);
        }).show();
      return true;
    });
    menu.show();
  }

  private void rename(JSONObject computer) {
    EditText input = input(getString(R.string.name));
    input.setText(computer.optString("name"));
    new AlertDialog.Builder(this).setTitle(R.string.rename).setView(input).setNegativeButton(R.string.cancel, null)
      .setPositiveButton(R.string.save, (dialog, which) -> {
        String name = input.getText().toString().trim();
        if (name.isEmpty()) return;
        try {
          computer.put("name", name.substring(0, Math.min(80, name.length())));
          computer.put("customName", true);
          saveRecords();
          showComputers();
        } catch (Exception error) { toast(R.string.save_error); }
      }).show();
  }

  private void help() {
    new AlertDialog.Builder(this).setTitle(getString(R.string.app_name) + " " + appVersion()).setMessage(R.string.help_body).setPositiveButton(android.R.string.ok, null).show();
  }

  private void scan() {
    new IntentIntegrator(this).setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
      .setPrompt(getString(R.string.scan_prompt)).setBeepEnabled(false).setOrientationLocked(false)
      .setBarcodeImageEnabled(false).initiateScan();
  }

  private void paste() {
    EditText input = input(getString(R.string.url_hint));
    input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
    input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
    input.setSaveEnabled(false);
    AlertDialog dialog = new AlertDialog.Builder(this).setTitle(R.string.add_title).setView(input)
      .setNegativeButton(R.string.cancel, null).setPositiveButton(R.string.connect, null).create();
    dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
      if (acceptLink(input.getText().toString())) { input.setText(""); dialog.dismiss(); }
      else { input.setError(linkError); showLinkFailure(); }
    }));
    dialog.show();
  }

  boolean acceptLink(String input) {
    linkError = null;
    linkErrorStage = null;
    final RemoteUrl url;
    try {
      url = RemoteUrl.parse(input);
      if (url.hostId == null && !url.pairing) throw new IllegalArgumentException("pairing_required");
    } catch (Exception error) { return rejectLink(R.string.invalid_url, qrFailureStage(error)); }
    final ComputerRecords next;
    final JSONObject record;
    try {
      // Do not expose an unsaved record or partially modify the current list.
      next = new ComputerRecords(records.serialize());
      record = next.add(url, Uri.parse(url.origin).getHost());
      next.setPendingProfileName(ComputerRecords.profileName(record), false);
      next.setPendingProfileDeletion(url.origin, false);
    } catch (IllegalArgumentException error) { return rejectLink(R.string.pairing_conflict, "TRUST"); }
    catch (Exception error) { return rejectLink(R.string.save_error, "SAVE"); }
    try {
      if (!recordWriter.test(preferences, next.serialize())) return rejectLink(R.string.save_error, "SAVE");
    } catch (Exception error) { return rejectLink(R.string.save_error, "SAVE"); }
    records = next;
    pairingLinks.put(ComputerRecords.id(record), url);
    if (url.hostId == null) {
      // A newly scanned QR explicitly trusts this address for this app process.
      // It cannot authorize discovering a replacement address or a cold restart.
      temporaryTrust.add(ComputerRecords.id(record));
    }
    // Show the persisted computer even if WebView or the first request fails.
    showComputers(false);
    connectComputer(record);
    return true;
  }

  String linkError() { return linkError; }

  private static String qrFailureStage(Exception error) {
    // Only fixed categories reach the UI. URI exceptions can include the input.
    String reason = error.getMessage();
    if ("invalid_public_key".equals(reason)) return "QR-KEY";
    if ("unsupported_pairing".equals(reason)) return "QR-VERSION";
    if ("invalid_pairing".equals(reason) || "duplicate_field".equals(reason) || "pairing_required".equals(reason)) return "QR-PAIR";
    if ("https_origin_required".equals(reason)) return "QR-DIRECTORY";
    if ("crypto_unavailable".equals(reason)) return "QR-CRYPTO";
    return "QR-LINK";
  }

  private boolean rejectLink(int resource, String stage) {
    linkErrorStage = stage;
    linkError = getString(resource) + " [" + stage + "]";
    return false;
  }

  private String appVersion() {
    try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
    catch (android.content.pm.PackageManager.NameNotFoundException ignored) { return ""; }
  }

  private void showLinkFailure() {
    // Android text toasts can truncate to two lines, hiding the reason on large fonts.
    // Keep the code first and the full explanation selectable until the user dismisses it.
    String message = linkError;
    String report = "cc-haha Mobile " + appVersion() + " / Android SDK " + android.os.Build.VERSION.SDK_INT + "\n" + message;
    AlertDialog dialog = new AlertDialog.Builder(this)
      .setTitle("[" + linkErrorStage + "] " + getString(R.string.pairing_failed_title))
      .setMessage(message)
      .setPositiveButton(android.R.string.ok, null)
      .setNeutralButton(R.string.copy_error, (ignored, which) -> getSystemService(ClipboardManager.class)
        .setPrimaryClip(ClipData.newPlainText(getString(R.string.pairing_failed_title), report)))
      .create();
    dialog.show();
    TextView body = dialog.findViewById(android.R.id.message);
    if (body != null) body.setTextIsSelectable(true);
  }

  private void connectComputer(JSONObject record) {
    if (!ComputerRecords.isBound(record) && !temporaryTrust.contains(ComputerRecords.id(record))) { toast(R.string.legacy_pairing); return; }
    String id = ComputerRecords.id(record);
    requestedComputer = null; restoreComputer = null;
    Runnable connect = () -> {
      closeBrowser();
      requestedComputer = id;
      showConnecting(record);
      failures.remove(id); nextAttempt.remove(id);
      checkComputer(record);
    };
    if (browser == null) connect.run();
    else captureBrowserState(browser, records.find(activeId), connect);
  }

  private void showConnecting(JSONObject record) {
    createRoot();
    LinearLayout content = column();
    content.setGravity(Gravity.CENTER);
    content.setPadding(dp(32), dp(24), dp(32), dp(24));
    root.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));
    ProgressBar spinner = new ProgressBar(this);
    spinner.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(ACCENT));
    content.addView(spinner, new LinearLayout.LayoutParams(dp(28), dp(28)));
    TextView title = text(record.optString("name"), 20, true);
    title.setGravity(Gravity.CENTER);
    title.setMaxLines(2);
    title.setEllipsize(android.text.TextUtils.TruncateAt.END);
    title.setPadding(0, dp(24), 0, dp(8));
    content.addView(title);
    connectingStatus = text(getString(R.string.resuming), 14, false);
    connectingStatus.setTextColor(MUTED);
    connectingStatus.setGravity(Gravity.CENTER);
    content.addView(connectingStatus);
    Button cancel = button(R.string.back_computers, false, v -> showComputers(false));
    LinearLayout.LayoutParams cancelLayout = new LinearLayout.LayoutParams(-1, dp(48));
    cancelLayout.setMargins(dp(24), 0, dp(24), dp(20));
    root.addView(cancel, cancelLayout);
  }

  private void leaveComputer() {
    requestedComputer = null; restoreComputer = null;
    if (browser == null) showComputers();
    else captureBrowserState(browser, records.find(activeId), this::showComputers);
  }

  private void connectionMenu(View anchor) {
    PopupMenu menu = new PopupMenu(this, anchor);
    menu.getMenu().add(R.string.back_computers).setOnMenuItemClickListener(item -> { leaveComputer(); return true; });
    menu.getMenu().add(R.string.retry).setOnMenuItemClickListener(item -> {
      JSONObject record = records.find(activeId);
      if (record != null) connectComputer(record);
      return true;
    });
    menu.getMenu().add(R.string.copy_link).setOnMenuItemClickListener(item -> { copy(activeOrigin); return true; });
    menu.show();
  }

  private void open(JSONObject record, String launchUrl) {
    // A verified endpoint can rotate during foreground polling. Preserve the
    // current draft before replacing that WebView, just as on app backgrounding.
    Runnable launch = () -> {
      try { openBrowser(record, launchUrl); }
      catch (Exception error) {
        closeBrowser(); showComputers(false);
        requestedComputer = ComputerRecords.id(record);
        browserFailure(record, R.string.webview_unavailable, "WEBVIEW");
      }
    };
    if (browser == null) launch.run();
    else captureBrowserState(browser, records.find(activeId), launch);
  }

  private void openBrowser(JSONObject record, String launchUrl) {
    closeBrowser();
    activeOrigin = record.optString("origin");
    activeId = ComputerRecords.id(record);
    activeProfile = ComputerRecords.profileName(record);
    activeName = record.optString("name");
    createRoot();
    connectingStatus = null;
    LinearLayout toolbar = row();
    toolbar.setBackgroundColor(Color.WHITE);
    toolbar.setPadding(dp(16), 0, dp(8), 0);
    ImageView computerIcon = new ImageView(this);
    computerIcon.setImageResource(R.drawable.ic_computer);
    computerIcon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
    LinearLayout.LayoutParams iconLayout = new LinearLayout.LayoutParams(dp(16), dp(16));
    iconLayout.rightMargin = dp(8);
    toolbar.addView(computerIcon, iconLayout);
    TextView title = text(activeName, 12, false);
    title.setMaxLines(1);
    title.setEllipsize(android.text.TextUtils.TruncateAt.END);
    toolbar.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
    browserStatus = text("", 11, false);
    browserStatus.setTextColor(MUTED);
    browserStatus.setMaxLines(1);
    browserStatus.setMaxWidth(dp(120));
    browserStatus.setEllipsize(android.text.TextUtils.TruncateAt.END);
    browserStatus.setPadding(dp(8), 0, 0, 0);
    toolbar.addView(browserStatus);
    Button menu = iconButton("⌄", R.string.connection_menu, v -> connectionMenu(v));
    toolbar.addView(menu, new LinearLayout.LayoutParams(dp(44), dp(44)));
    toolbar.setOnClickListener(v -> connectionMenu(menu));
    toolbar.setContentDescription(getString(R.string.connection_menu) + " " + activeName);
    root.addView(toolbar, new LinearLayout.LayoutParams(-1, dp(44)));
    ProgressBar progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
    progress.setMax(100);
    root.addView(progress, new LinearLayout.LayoutParams(-1, dp(3)));
    errorBanner = column();
    errorBanner.setPadding(dp(16), dp(12), dp(16), dp(12));
    errorBanner.addView(text(getString(R.string.connection_failed), 14, false));
    errorBanner.addView(button(R.string.retry, false, v -> {
      JSONObject currentRecord = records.find(activeId);
      if (currentRecord != null) connectComputer(currentRecord);
    }));
    errorBanner.setVisibility(View.GONE);
    root.addView(errorBanner);
    browser = browserFactory.apply(this);
    WebView current = browser;
    RemoteBrowser.configure(current, activeOrigin, activeProfile, new RemoteBrowser.Events() {
      @Override public void external(String target) { openExternal(target); }
      @Override public void failure() { if (browser == current) { errorBanner.setVisibility(View.VISIBLE); nextAttempt.remove(activeId); refreshStatuses(); } }
      private boolean restored;
      @Override public void loaded() {
        if (browser == current && !restored) {
          restored = true;
          restoreUiState(current, record, 0);
        }
      }
      @Override public void progress(int value) { progress.setProgress(value); progress.setVisibility(value == 100 ? View.GONE : View.VISIBLE); }
      @Override public boolean chooseFiles(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams parameters) { return selectFiles(callback, parameters); }
    });
    root.addView(current, new LinearLayout.LayoutParams(-1, 0, 1));
    current.loadUrl(launchUrl);
    updateStatus(activeId, states.getOrDefault(activeId, SessionProbe.State.CHECKING));
    try { records.opened(record); saveRecords(); }
    catch (Exception error) { toast(R.string.save_error); }
  }

  private void openExternal(String target) {
    try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(target)).addCategory(Intent.CATEGORY_BROWSABLE)); }
    catch (Exception error) { toast(R.string.unavailable); }
  }

  private boolean selectFiles(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams parameters) {
    if (filesCallback != null) filesCallback.onReceiveValue(null);
    filesCallback = callback;
    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
    String[] accepted = parameters.getAcceptTypes();
    if (accepted.length > 0 && !accepted[0].isEmpty()) intent.putExtra(Intent.EXTRA_MIME_TYPES, accepted);
    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, parameters.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE);
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    try { startActivityForResult(Intent.createChooser(intent, getString(R.string.choose_file)), FILE_REQUEST); }
    catch (Exception error) { filesCallback.onReceiveValue(null); filesCallback = null; toast(R.string.unavailable); }
    return true;
  }

  @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode == FILE_REQUEST) {
      if (filesCallback != null) {
        Uri[] result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
        if (result != null) for (Uri uri : result) {
          if (!"content".equals(uri.getScheme())) { result = null; break; }
        }
        filesCallback.onReceiveValue(result);
        filesCallback = null;
      }
      return;
    }
    IntentResult result = IntentIntegrator.parseActivityResult(requestCode, resultCode, data);
    if (result != null && result.getContents() != null && !acceptLink(result.getContents())) showLinkFailure();
  }

  private void refreshStatuses() {
    if (records == null) return;
    for (int i = 0; i < records.computers().length(); i++) checkComputer(records.computers().optJSONObject(i));
  }

  private void checkComputer(JSONObject record) {
    String id = ComputerRecords.id(record);
    if (!ComputerRecords.isBound(record) && !temporaryTrust.contains(id)) { updateStatus(id, SessionProbe.State.LEGACY); return; }
    if (checking.containsKey(id) || failures.getOrDefault(id, 0) >= 5 || System.currentTimeMillis() < nextAttempt.getOrDefault(id, 0L)) return;
    Object ticket = new Object();
    checking.put(id, ticket);
    connectionProblems.remove(id);
    updateStatus(id, SessionProbe.State.CHECKING);
    try {
      if (!profileSupport.getAsBoolean()) { browserFailure(record, R.string.webview_update, "WEBVIEW"); return; }
    } catch (Exception error) { browserFailure(record, R.string.webview_unavailable, "WEBVIEW"); return; }
    final JSONObject snapshot;
    try { snapshot = new JSONObject(record.toString()); snapshot.put("nativePairing", pairingLinks.containsKey(id)); }
    catch (Exception error) { checking.remove(id); return; }
    final String cookie;
    try { cookie = profileCookies.apply(ComputerRecords.profileName(record), record.optString("origin")); }
    catch (Exception error) { browserFailure(record, R.string.webview_unavailable, "PROFILE"); return; }
    requests.execute(() -> {
      ReconnectClient.Result result;
      if (ComputerRecords.isBound(snapshot)) result = connector.connect(snapshot, cookie);
      else {
        SessionProbe.Result temporary = temporaryProbe.read(snapshot.optString("origin"), cookie);
        result = new ReconnectClient.Result(temporary.state, snapshot.optString("origin"), 0, null, null, temporary.hostName);
      }
      handler.post(() -> {
        if (isDestroyed() || checking.get(id) != ticket) return;
        checking.remove(id);
        JSONObject current = records.find(id);
        if (current == null || !current.optString("keyAlias").equals(snapshot.optString("keyAlias")) || (!ComputerRecords.isBound(current) && !temporaryTrust.contains(id))) return;
        if (result.state == SessionProbe.State.ONLINE || result.state == SessionProbe.State.UNPAIRED) {
          failures.remove(id);
          nextAttempt.put(id, System.currentTimeMillis() + (result.state == SessionProbe.State.UNPAIRED ? 5000 : 15000));
          Runnable apply = () -> {
            if (isDestroyed() || records.find(id) != current) return;
            try {
              if (result.state == SessionProbe.State.UNPAIRED) current.remove("deviceId");
              if (ComputerRecords.isBound(current)) records.connected(current, result);
              else if (result.hostName != null && !current.optBoolean("customName")) current.put("name", result.hostName.substring(0, Math.min(80, result.hostName.length())));
              if (!saveRecords()) { browserFailure(current, R.string.save_error, "SAVE"); return; }
            } catch (Exception error) { browserFailure(current, R.string.save_error, "SAVE"); return; }
            try {
              boolean explicitlyRequested = id.equals(requestedComputer);
              boolean changedActive = BrowserRecoveryPolicy.replaceDocument(activeId, activeOrigin, id, result.origin);
              if (resumed && pendingCapture == null && (explicitlyRequested || changedActive)) {
                RemoteUrl pairing = pairingLinks.get(id);
                String launch = result.origin + "/remote";
                if (result.state == SessionProbe.State.UNPAIRED && pairing != null && pairing.origin.equals(result.origin)) launch = pairing.launchUrl;
                open(current, launch);
                requestedComputer = null;
              } else if (resumed && browser != null && id.equals(activeId) && result.origin.equals(activeOrigin) && result.cookie != null) {
                // Cookie renewal for the same verified host does not invalidate
                // the loaded document, its draft, scroll position or live socket.
                RemoteBrowser.resume(browser);
              }
              if (result.state == SessionProbe.State.ONLINE) pairingLinks.remove(id);
              updateStatus(id, result.state);
            } catch (Exception error) {
              closeBrowser();
              showComputers(false);
              // showComputers clears the request; this foreground failure still needs feedback.
              requestedComputer = id;
              browserFailure(current, R.string.webview_unavailable, "WEBVIEW");
            }
          };
          if (result.cookie == null) apply.run();
          else {
            String profile = BrowserProfiles.key(id, result.origin);
            try {
              BrowserProfiles.cookiesNamed(profile).setCookie(result.origin, result.cookie, accepted -> {
                try {
                  if (Boolean.TRUE.equals(accepted)) {
                    BrowserProfiles.cookiesNamed(profile).flush();
                    if (records.find(id) != current) BrowserProfiles.clearNamed(profile, () -> {});
                    else apply.run();
                  }
                  else browserFailure(current, R.string.connection_failed, "COOKIE");
                } catch (Exception error) { browserFailure(current, R.string.webview_unavailable, "PROFILE"); }
              });
            } catch (Exception error) { browserFailure(current, R.string.webview_unavailable, "PROFILE"); }
          }
        } else {
          int count = failures.getOrDefault(id, 0) + 1;
          failures.put(id, result.state == SessionProbe.State.PAIR_REQUIRED || result.state == SessionProbe.State.IDENTITY_FAILED ? 5 : count);
          nextAttempt.put(id, System.currentTimeMillis() + Math.min(60000, 2000L << Math.min(count, 5)));
          updateStatus(id, result.state);
          if (id.equals(requestedComputer)) { showComputers(false); toastForState(result.state); }
          if (id.equals(activeId)) {
            if (result.state == SessionProbe.State.IDENTITY_FAILED || result.state == SessionProbe.State.PAIR_REQUIRED) { suspendBrowser(); showComputers(); }
            else if (errorBanner != null) errorBanner.setVisibility(View.VISIBLE);
          }
        }
      });
    });
  }

  private void updateStatus(String id, SessionProbe.State state) {
    states.put(id, state);
    String labelText = id.startsWith("legacy:") && state == SessionProbe.State.ONLINE ? getString(R.string.temporary_online) : statusText(state);
    TextView label = labels.get(id);
    if (label != null) label.setText(labelText);
    if (id.equals(activeId) && browserStatus != null) {
      // Routine health probes should not make a working connection blink.
      if (state != SessionProbe.State.CHECKING) {
        browserStatus.setText(state == SessionProbe.State.ONLINE ? getString(R.string.connected) : labelText);
        browserStatus.setTextColor(state == SessionProbe.State.ONLINE ? 0xff38845b : MUTED);
      }
    }
  }

  private void browserFailure(JSONObject record, int resource, String stage) {
    String id = ComputerRecords.id(record);
    checking.remove(id);
    failures.remove(id);
    nextAttempt.put(id, System.currentTimeMillis() + 15000);
    String message = getString(resource) + " [" + stage + "]";
    connectionProblems.put(id, message);
    states.put(id, SessionProbe.State.OFFLINE);
    TextView label = labels.get(id);
    if (label != null) label.setText(message);
    if (id.equals(activeId) && browserStatus != null) browserStatus.setText(message);
    if (id.equals(requestedComputer)) {
      showComputers(false);
      Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }
  }

  private void toastForState(SessionProbe.State state) {
    Toast.makeText(this, statusText(state), Toast.LENGTH_LONG).show();
  }

  private String statusText(SessionProbe.State state) {
    int resource = switch (state) {
      case ONLINE -> R.string.online;
      case UNPAIRED -> R.string.unpaired;
      case OFFLINE -> R.string.offline;
      case INCOMPATIBLE -> R.string.incompatible;
      case LEGACY -> R.string.legacy_pairing;
      case PAIR_REQUIRED -> R.string.pair_required;
      case IDENTITY_FAILED -> R.string.identity_failed;
      default -> R.string.checking;
    };
    return getString(resource);
  }

  private void copy(String origin) {
    getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText(getString(R.string.app_name), origin + "/remote"));
    toast(R.string.copied);
  }

  private void removeComputer(JSONObject record) {
    String id = ComputerRecords.id(record);
    try {
      checking.remove(id); pairingLinks.remove(id); temporaryTrust.remove(id);
      if (id.equals(activeId)) closeBrowser();
      if (id.equals(requestedComputer)) requestedComputer = null;
      if (ComputerRecords.isBound(record)) new DeviceKeys().delete(record.optString("keyAlias"));
      java.util.Set<String> profiles = ComputerRecords.profiles(record);
      for (String profile : profiles) records.setPendingProfileName(profile, true);
      if (!saveRecords()) return;
      java.util.concurrent.atomic.AtomicInteger remaining = new java.util.concurrent.atomic.AtomicInteger(profiles.size());
      Runnable complete = () -> {
        if (remaining.decrementAndGet() == 0) { records.remove(id); saveRecords(); showComputers(); }
      };
      if (profiles.isEmpty()) { records.remove(id); saveRecords(); showComputers(); }
      else for (String profile : profiles) BrowserProfiles.clearNamed(profile, complete);
    } catch (Exception error) { toast(R.string.remove_failed); }
  }

  private void cleanupRemovedProfiles() {
    try { if (!profileSupport.getAsBoolean()) return; }
    catch (Exception ignored) { return; }
    for (String origin : records.pendingProfileDeletions()) {
      try { BrowserProfiles.remove(origin); records.setPendingProfileDeletion(origin, false); }
      catch (Exception ignored) { /* Retry after the next cold process start. */ }
    }
    for (String profile : records.pendingProfileNames()) {
      try { BrowserProfiles.removeNamed(profile); records.setPendingProfileName(profile, false); }
      catch (Exception ignored) { /* Keep the cleanup queue on failure. */ }
    }
  }

  void recoverConnection() {
    failures.clear(); nextAttempt.clear();
    if (restoreComputer != null && records != null && records.find(restoreComputer) != null) {
      requestedComputer = restoreComputer; restoreComputer = null;
      if (requestedComputer.startsWith("legacy:") && !temporaryTrust.contains(requestedComputer)) { showComputers(); return; }
      showConnecting(records.find(requestedComputer));
    }
    // Only an already verified, uninterrupted WebView can be resumed in place.
    if (browser != null) RemoteBrowser.resume(browser);
    refreshStatuses();
  }

  @Override protected void onResume() {
    super.onResume();
    resumed = true;
    BrowserRecoveryPolicy.Resume action = BrowserRecoveryPolicy.resume(browser != null, restoreComputer != null);
    if (action == BrowserRecoveryPolicy.Resume.REUSE) {
      RemoteBrowser.resume(browser);
      // Preserve health-check deadlines. A brief app switch is not a new pairing.
      refreshStatuses();
    } else if (action == BrowserRecoveryPolicy.Resume.REVERIFY) recoverConnection();
    else {
      // An in-flight cold launch may finish while the Activity is paused.
      // Only that pending intent needs a fresh attempt, not every saved computer.
      if (requestedComputer != null) nextAttempt.remove(requestedComputer);
      refreshStatuses();
    }
    handler.removeCallbacks(poll);
    handler.postDelayed(poll, 5000);
  }

  @Override protected void onPause() {
    resumed = false;
    handler.removeCallbacks(poll);
    if (browser != null) {
      browser.onPause();
      BrowserProfiles.cookiesNamed(activeProfile).flush();
      // Keep the verified document and socket through ordinary app switches.
      // Capture is only a process-death fallback, not a reason to destroy it.
      if (pendingCapture == null) captureBrowserState(browser, records.find(activeId), () -> {}, false);
    }
    super.onPause();
  }

  @Override protected void onSaveInstanceState(Bundle out) {
    super.onSaveInstanceState(out);
    String selected = activeId != null ? activeId : restoreComputer != null ? restoreComputer : requestedComputer;
    if (selected != null) out.putString("computerId", selected);
  }

  @Override public void onBackPressed() {
    if (browser == null) { backgroundTask.accept(this); return; }
    if (pendingBack != null) return;
    WebView current = browser;
    Object ticket = new Object();
    pendingBack = ticket;
    java.util.function.Consumer<String> complete = result -> {
      if (pendingBack != ticket || browser != current || isDestroyed()) return;
      pendingBack = null;
      NavigationPolicy.BackAction action = NavigationPolicy.backAction(result, current.canGoBack());
      if (action == NavigationPolicy.BackAction.HISTORY) current.goBack();
      else if (action == NavigationPolicy.BackAction.BACKGROUND) backgroundTask.accept(this);
    };
    Runnable timeout = () -> complete.accept(null);
    handler.postDelayed(timeout, 350);
    try {
      // Time out only the read-only capability probe. Once a mutating SPA Back
      // has been dispatched, a native timeout must not also navigate history:
      // a slow renderer could still execute the first action afterward.
      current.evaluateJavascript("typeof window.__CC_HAHA_MOBILE_NAVIGATE_BACK__ === 'function'", available -> {
        handler.removeCallbacks(timeout);
        if (pendingBack != ticket || browser != current || isDestroyed()) return;
        if (!"true".equals(available)) { complete.accept(null); return; }
        try {
          current.evaluateJavascript("(()=>{try{return window.__CC_HAHA_MOBILE_NAVIGATE_BACK__()}catch{return null}})()", complete::accept);
        } catch (Exception unavailable) { complete.accept(null); }
      });
    } catch (Exception unavailable) {
      handler.removeCallbacks(timeout);
      complete.accept(null);
    }
  }

  private void suspendBrowser() {
    if (browser == null || activeId == null) return;
    restoreComputer = activeId;
    captureBrowserState(browser, records.find(activeId), () -> {
      closeBrowser();
      if (resumed) recoverConnection();
    });
  }

  private void captureBrowserState(WebView current, JSONObject record, Runnable continuation) {
    captureBrowserState(current, record, continuation, true);
  }

  private void captureBrowserState(WebView current, JSONObject record, Runnable continuation, boolean transition) {
    Object ticket = new Object();
    latestCapture = ticket;
    if (transition) pendingCapture = ticket;
    Runnable finish = () -> {
      if (latestCapture != ticket || browser != current) return;
      latestCapture = null;
      if (transition) pendingCapture = null;
      continuation.run();
    };
    // This boundary is shared by foreground retries, endpoint rotation and
    // background recovery. A stalled renderer cannot hold a transition forever.
    handler.postDelayed(finish, 250);
    try {
      current.evaluateJavascript("(()=>{try{return window.__ccHahaMobileState?.capture()??null}catch{return null}})()", value -> {
        if (latestCapture != ticket || browser != current) return;
        try {
          if (record != null && records.find(ComputerRecords.id(record)) == record && value != null && value.length() <= 500000) {
            JSONObject state = MobileUiState.sanitize(new JSONObject(value));
            if (state != null) { record.put("uiState", state); saveRecords(); }
          }
        } catch (Exception ignored) { /* Keep the last valid snapshot when capture is unavailable. */ }
        handler.removeCallbacks(finish);
        finish.run();
      });
    } catch (Exception unavailable) {
      handler.removeCallbacks(finish);
      finish.run();
    }
  }

  private void restoreUiState(WebView current, JSONObject record, int attempt) {
    if (browser != current || records.find(ComputerRecords.id(record)) != record || attempt >= 120) return;
    JSONObject snapshot = MobileUiState.sanitize(record.optJSONObject("uiState"));
    if (snapshot == null) return;
    current.evaluateJavascript("(()=>{if(!window.__ccHahaMobileState)return false;window.__ccHahaMobileState.restore(" + snapshot + ");return true})()", result -> {
      if (!"true".equals(result)) handler.postDelayed(() -> restoreUiState(current, record, attempt + 1), 500);
    });
  }

  private void closeBrowser() {
    pendingCapture = null; latestCapture = null; pendingBack = null;
    if (filesCallback != null) { filesCallback.onReceiveValue(null); filesCallback = null; }
    if (browser != null) {
      try { BrowserProfiles.cookiesNamed(activeProfile).flush(); } catch (Exception ignored) { }
      if (browser.getParent() instanceof ViewGroup) ((ViewGroup) browser.getParent()).removeView(browser);
      try { browser.stopLoading(); browser.clearHistory(); } catch (Exception ignored) { }
      try { browser.destroy(); } catch (Exception ignored) { }
      browser = null;
    }
    activeOrigin = null; activeId = null; activeProfile = null;
    browserStatus = null;
  }

  @Override protected void onDestroy() {
    closeBrowser();
    handler.removeCallbacksAndMessages(null);
    requests.shutdownNow();
    if (connectivity != null) connectivity.unregisterNetworkCallback(networkCallback);
    super.onDestroy();
  }

  private LinearLayout column() { LinearLayout v = new LinearLayout(this); v.setOrientation(LinearLayout.VERTICAL); return v; }
  private LinearLayout row() { LinearLayout v = new LinearLayout(this); v.setGravity(Gravity.CENTER_VERTICAL); return v; }
  private TextView text(String value, int size, boolean bold) {
    TextView v = new TextView(this); v.setText(value); v.setTextSize(size); v.setTextColor(INK);
    v.setLineSpacing(dp(3), 1); v.setTypeface(Typeface.create("sans-serif", bold ? Typeface.BOLD : Typeface.NORMAL)); return v;
  }
  private Button button(int label, boolean primary, View.OnClickListener click) {
    Button v = new Button(this); v.setText(label); v.setAllCaps(false); v.setTextSize(14);
    v.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
    v.setMinimumWidth(0); v.setMinWidth(0);
    v.setMinHeight(dp(48)); v.setTextColor(primary ? Color.WHITE : ACCENT); v.setOnClickListener(click);
    GradientDrawable shape = new GradientDrawable();
    shape.setColor(primary ? ACCENT : Color.TRANSPARENT);
    shape.setCornerRadius(dp(14));
    v.setBackground(new android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(0x14292a2d), shape, null));
    v.setElevation(0);
    v.setStateListAnimator(null);
    v.setPadding(dp(14), dp(8), dp(14), dp(8));
    return v;
  }
  private Button iconButton(String glyph, int description, View.OnClickListener click) {
    Button v = button(description, false, click);
    v.setText(glyph); v.setTextSize(20);
    v.setContentDescription(getString(description));
    v.setMinHeight(0); v.setMinimumHeight(0); v.setPadding(0, 0, 0, 0);
    return v;
  }
  private EditText input(String hint) { EditText v = new EditText(this); v.setSingleLine(true); v.setHint(hint); v.setPadding(dp(24), dp(12), dp(24), dp(12)); return v; }
  private LinearLayout card() {
    LinearLayout v = column(); v.setPadding(dp(18), dp(14), dp(18), dp(14));
    GradientDrawable background = new GradientDrawable(); background.setColor(Color.WHITE); background.setCornerRadius(dp(16));
    background.setStroke(dp(1), 0xffe7e7e9); v.setBackground(background); return v;
  }
  private LinearLayout.LayoutParams spaced() { LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2); p.topMargin = dp(20); return p; }
  private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
  private void toast(int resource) { Toast.makeText(this, resource, Toast.LENGTH_LONG).show(); }
}
