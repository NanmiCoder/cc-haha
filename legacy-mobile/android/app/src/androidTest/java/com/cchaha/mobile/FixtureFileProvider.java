package com.cchaha.mobile;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.FileNotFoundException;
import java.nio.charset.StandardCharsets;

/** Test APK only. Produces disposable bytes to exercise the real WebView upload path. */
public class FixtureFileProvider extends ContentProvider {
  static final byte[] BYTES = "fixture upload bytes".getBytes(StandardCharsets.UTF_8);
  @Override public boolean onCreate() { return true; }
  @Override public String getType(Uri uri) { return "text/plain"; }
  @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
    MatrixCursor cursor = new MatrixCursor(new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE });
    cursor.addRow(new Object[] { "fixture.txt", BYTES.length });
    return cursor;
  }
  @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
    if (!"r".equals(mode)) throw new FileNotFoundException();
    try {
      java.io.File file = new java.io.File(getContext().getCacheDir(), "mobile-upload-fixture.txt");
      try (var stream = new java.io.FileOutputStream(file)) { stream.write(BYTES); }
      return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    } catch (Exception error) { throw new FileNotFoundException(); }
  }
  @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
  @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
  @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
}
