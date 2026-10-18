package app.shakespeare.mobile;

import android.database.Cursor;
import android.database.sqlite.SQLiteCursor;
import android.database.sqlite.SQLiteCursorDriver;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteQuery;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Local profile store for the shared Vue client.
 * Private keys are sandbox files outside the club database. Folder reads stay
 * inside the app files directory. This class does not log SQL, file bytes, or keys.
 */
@CapacitorPlugin(name = "Shakespeare")
public class ShakespearePlugin extends Plugin {
    private static final int MAX_FILES = 20;
    private static final int MAX_BYTES = 256 * 1024;
    private static final int MAX_FRAME = 1_048_576;
    private static final int TIMEOUT_MS = 5_000;

    private final Object gate = new Object();

    private static void rejectUnexpected(PluginCall call) {
        call.reject("The folder is not available.");
    }

    private static void applyPragma(SQLiteDatabase database, String sql) {
        try (Cursor cursor = database.rawQuery(sql, null)) {
            cursor.moveToFirst();
        }
    }
    private SQLiteDatabase database;

    @Override
    protected void handleOnDestroy() {
        synchronized (gate) {
            closeDatabase();
        }
    }

    @PluginMethod
    public void profileList(PluginCall call) {
        try {
            File root = new File(filesDir(), "profiles");
            JSArray profiles = new JSArray();
            if (root.isDirectory()) {
                File[] entries = root.listFiles();
                List<String> names = new ArrayList<>();
                if (entries != null) {
                    for (File entry : entries) {
                        if (entry.isDirectory() && isHex(entry.getName(), 64)) {
                            names.add(entry.getName());
                        }
                    }
                }
                Collections.sort(names);
                for (String name : names) {
                    profiles.put(name);
                }
            }
            JSObject result = new JSObject();
            result.put("profiles", profiles);
            call.resolve(result);
        } catch (PluginFailure failure) {
            call.reject(failure.getMessage());
        } catch (Exception ex) {
            rejectUnexpected(call);
        }
    }

    @PluginMethod
    public void profileOpen(PluginCall call) {
        String publicKey = call.getString("publicKey");
        synchronized (gate) {
            try {
                requirePublicKey(publicKey);
                File dir = new File(new File(filesDir(), "profiles"), publicKey);
                if (!dir.isDirectory() && !dir.mkdirs()) {
                    throw new PluginFailure("The folder is not available.");
                }
                SQLiteDatabase opened = SQLiteDatabase.openOrCreateDatabase(new File(dir, "club.sqlite"), null);
                try {
                    applyPragma(opened, "PRAGMA foreign_keys = ON");
                    applyPragma(opened, "PRAGMA busy_timeout = 5000");
                } catch (RuntimeException ex) {
                    opened.close();
                    throw ex;
                }
                SQLiteDatabase previous = database;
                database = opened;
                if (previous != null && previous.isOpen()) {
                    previous.close();
                }
                call.resolve();
            } catch (PluginFailure failure) {
                call.reject(failure.getMessage());
            } catch (Exception ex) {
                rejectUnexpected(call);
            }
        }
    }

    @PluginMethod
    public void dbExecute(PluginCall call) {
        synchronized (gate) {
            try {
                SQLiteDatabase open = requireDatabase();
                String sql = requireSql(call);
                Object[] args = bindArgs(call.getArray("params"));
                if (args.length == 0) {
                    open.execSQL(sql);
                } else {
                    open.execSQL(sql, args);
                }
                call.resolve();
            } catch (PluginFailure failure) {
                call.reject(failure.getMessage());
            } catch (android.database.SQLException ex) {
                call.reject(sqlFailure(ex));
            } catch (Exception ex) {
                call.reject("The request is not allowed.");
            }
        }
    }

    @PluginMethod
    public void dbSelect(PluginCall call) {
        synchronized (gate) {
            Cursor cursor = null;
            try {
                SQLiteDatabase open = requireDatabase();
                String sql = requireSql(call);
                final Object[] args = bindArgs(call.getArray("params"));
                cursor = open.rawQueryWithFactory(
                    new SQLiteDatabase.CursorFactory() {
                        @Override
                        public Cursor newCursor(
                            SQLiteDatabase db,
                            SQLiteCursorDriver driver,
                            String editTable,
                            SQLiteQuery query
                        ) {
                            bindQuery(query, args);
                            return new SQLiteCursor(driver, editTable, query);
                        }
                    },
                    sql,
                    null,
                    null
                );
                JSArray rows = new JSArray();
                String[] names = cursor.getColumnNames();
                while (cursor.moveToNext()) {
                    JSObject row = new JSObject();
                    for (int index = 0; index < names.length; index++) {
                        row.put(names[index], columnValue(cursor, index));
                    }
                    rows.put(row);
                }
                JSObject result = new JSObject();
                result.put("rows", rows);
                call.resolve(result);
            } catch (PluginFailure failure) {
                call.reject(failure.getMessage());
            } catch (android.database.SQLException ex) {
                call.reject(sqlFailure(ex));
            } catch (Exception ex) {
                call.reject("The request is not allowed.");
            } finally {
                if (cursor != null) {
                    cursor.close();
                }
            }
        }
    }

    @PluginMethod
    public void keystoreSave(PluginCall call) {
        synchronized (gate) {
            try {
                String publicKey = call.getString("publicKey");
                String privateKey = call.getString("privateKey");
                requirePublicKey(publicKey);
                if (!isHex(privateKey, 64)) {
                    throw new PluginFailure("Key material is not valid hex");
                }
                File dir = new File(filesDir(), "keys");
                if (!dir.isDirectory() && !dir.mkdirs()) {
                    throw new PluginFailure("The folder is not available.");
                }
                File dest = new File(dir, publicKey);
                try (FileOutputStream out = new FileOutputStream(dest)) {
                    out.write(privateKey.getBytes(StandardCharsets.US_ASCII));
                }
                call.resolve();
            } catch (PluginFailure failure) {
                call.reject(failure.getMessage());
            } catch (Exception ex) {
                rejectUnexpected(call);
            }
        }
    }

    @PluginMethod
    public void keystoreLoad(PluginCall call) {
        synchronized (gate) {
            try {
                String publicKey = call.getString("publicKey");
                requirePublicKey(publicKey);
                File dest = new File(new File(filesDir(), "keys"), publicKey);
                JSObject result = new JSObject();
                if (!dest.isFile()) {
                    result.put("privateKey", JSONObject.NULL);
                    call.resolve(result);
                    return;
                }
                byte[] stored = readLimited(dest, 64);
                if (stored.length != 64) {
                    throw new PluginFailure("The stored identity is unusable");
                }
                String text = new String(stored, StandardCharsets.US_ASCII);
                if (!isHex(text, 64)) {
                    throw new PluginFailure("The stored identity is unusable");
                }
                result.put("privateKey", text);
                call.resolve(result);
            } catch (PluginFailure failure) {
                call.reject(failure.getMessage());
            } catch (Exception ex) {
                rejectUnexpected(call);
            }
        }
    }

    @PluginMethod
    public void readShareFolder(PluginCall call) {
        synchronized (gate) {
            try {
                String path = call.getString("path");
                if (path == null || path.isEmpty()) {
                    throw new PluginFailure("That path is not allowed.");
                }
                File filesRoot = filesDir().getCanonicalFile();
                File requested = new File(path).getCanonicalFile();
                if (!isUnder(filesRoot, requested)) {
                    throw new PluginFailure("That path is not allowed.");
                }
                if (!requested.isDirectory()) {
                    throw new PluginFailure("The folder is not available.");
                }
                List<SharedFile> files = new ArrayList<>();
                collect(requested, requested, files);
                Collections.sort(files, new Comparator<SharedFile>() {
                    @Override
                    public int compare(SharedFile left, SharedFile right) {
                        return left.path.compareTo(right.path);
                    }
                });
                JSArray listed = new JSArray();
                for (SharedFile file : files) {
                    JSObject entry = new JSObject();
                    entry.put("path", file.path);
                    entry.put("bytes", byteArray(file.bytes));
                    listed.put(entry);
                }
                JSObject result = new JSObject();
                result.put("files", listed);
                call.resolve(result);
            } catch (PluginFailure failure) {
                call.reject(failure.getMessage());
            } catch (Exception ex) {
                call.reject("The folder is not available.");
            }
        }
    }

    @PluginMethod
    public void readProfileBlob(PluginCall call) {
        synchronized (gate) {
            try {
                File path = blobFile(call.getString("publicKey"), call.getString("hash"));
                JSObject result = new JSObject();
                if (!path.isFile()) {
                    result.put("bytes", JSONObject.NULL);
                } else {
                    result.put("bytes", byteArray(readLimited(path, MAX_BYTES)));
                }
                call.resolve(result);
            } catch (PluginFailure failure) {
                call.reject(failure.getMessage());
            } catch (Exception ex) {
                call.reject("The folder is not available.");
            }
        }
    }

    @PluginMethod
    public void writeProfileBlob(PluginCall call) {
        synchronized (gate) {
            try {
                byte[] bytes = readByteArg(call.getArray("bytes"));
                if (bytes.length > MAX_BYTES) {
                    throw new PluginFailure("The file is too large.");
                }
                File path = blobFile(call.getString("publicKey"), call.getString("hash"));
                writeFile(path, bytes);
                call.resolve();
            } catch (PluginFailure failure) {
                call.reject(failure.getMessage());
            } catch (Exception ex) {
                call.reject("The folder is not available.");
            }
        }
    }

    @PluginMethod
    public void removeProfileBlob(PluginCall call) {
        synchronized (gate) {
            try {
                File path = blobFile(call.getString("publicKey"), call.getString("hash"));
                if (path.isFile() && !path.delete()) {
                    throw new PluginFailure("The folder is not available.");
                }
                call.resolve();
            } catch (PluginFailure failure) {
                call.reject(failure.getMessage());
            } catch (Exception ex) {
                call.reject("The folder is not available.");
            }
        }
    }

    @PluginMethod
    public void writeDownload(PluginCall call) {
        synchronized (gate) {
            try {
                byte[] bytes = readByteArg(call.getArray("bytes"));
                File path = downloadFile(call.getString("publicKey"), call.getString("relativePath"));
                writeFile(path, bytes);
                call.resolve();
            } catch (PluginFailure failure) {
                call.reject(failure.getMessage());
            } catch (Exception ex) {
                call.reject("The folder is not available.");
            }
        }
    }

    @PluginMethod
    public void removeDownload(PluginCall call) {
        synchronized (gate) {
            try {
                File path = downloadFile(call.getString("publicKey"), call.getString("relativePath"));
                if (path.isFile() && !path.delete()) {
                    throw new PluginFailure("The folder is not available.");
                }
                call.resolve();
            } catch (PluginFailure failure) {
                call.reject(failure.getMessage());
            } catch (Exception ex) {
                call.reject("The folder is not available.");
            }
        }
    }

    @PluginMethod
    public void relayExchange(PluginCall call) {
        String host = call.getString("host");
        Integer port = call.getInt("port");
        String request = call.getString("request");
        if (request == null) {
            request = "";
        }
        if ((!"127.0.0.1".equals(host) && !"10.0.2.2".equals(host)) || port == null || port < 1 || port > 65535) {
            call.reject("The request is not allowed.");
            return;
        }
        byte[] body = request.getBytes(StandardCharsets.UTF_8);
        if (body.length > MAX_FRAME) {
            call.reject("The request is not allowed.");
            return;
        }
        Socket socket = new Socket();
        try {
            socket.connect(new InetSocketAddress(host, port), TIMEOUT_MS);
            socket.setSoTimeout(TIMEOUT_MS);
            OutputStream out = socket.getOutputStream();
            out.write(ByteBuffer.allocate(4).putInt(body.length).array());
            out.write(body);
            out.flush();
            InputStream in = socket.getInputStream();
            byte[] lengthBuf = readExact(in, 4);
            int length = ByteBuffer.wrap(lengthBuf).getInt();
            if (length < 0 || length > MAX_FRAME) {
                call.reject("The request is not allowed.");
                return;
            }
            String response = utf8(readExact(in, length));
            JSObject result = new JSObject();
            result.put("response", response);
            call.resolve(result);
        } catch (PluginFailure failure) {
            call.reject(failure.getMessage());
        } catch (Exception ex) {
            call.reject("The hub is not reachable.");
        } finally {
            try {
                socket.close();
            } catch (IOException ignored) {
                // The response was already delivered or rejected.
            }
        }
    }

    private File filesDir() throws PluginFailure {
        if (getContext() == null) {
            throw new PluginFailure("The folder is not available.");
        }
        return getContext().getFilesDir();
    }

    private SQLiteDatabase requireDatabase() throws PluginFailure {
        if (database == null || !database.isOpen()) {
            throw new PluginFailure("No profile is open");
        }
        return database;
    }

    private void closeDatabase() {
        if (database != null && database.isOpen()) {
            database.close();
        }
        database = null;
    }

    private static String requireSql(PluginCall call) throws PluginFailure {
        String sql = call.getString("sql");
        if (sql == null) {
            throw new PluginFailure("The request is not allowed.");
        }
        return sql;
    }

    private static Object[] bindArgs(JSArray params) throws PluginFailure {
        if (params == null) {
            return new Object[0];
        }
        Object[] args = new Object[params.length()];
        for (int index = 0; index < params.length(); index++) {
            Object value;
            try {
                value = params.get(index);
            } catch (JSONException ex) {
                throw new PluginFailure("SQL parameters must be null, string, or number");
            }
            args[index] = toSql(value);
        }
        return args;
    }

    private static Object toSql(Object value) throws PluginFailure {
        if (value == null || value == JSONObject.NULL) {
            return null;
        }
        if (value instanceof String) {
            return value;
        }
        if (value instanceof Integer || value instanceof Long || value instanceof Short) {
            return Long.valueOf(((Number) value).longValue());
        }
        if (value instanceof Double || value instanceof Float) {
            double real = ((Number) value).doubleValue();
            if (!Double.isFinite(real)) {
                throw new PluginFailure("SQL parameters must be finite numbers");
            }
            if (real == Math.rint(real) && Math.abs(real) <= 9007199254740992.0) {
                return Long.valueOf((long) real);
            }
            return Double.valueOf(real);
        }
        throw new PluginFailure("SQL parameters must be null, string, or number");
    }

    private static void bindQuery(SQLiteQuery query, Object[] args) {
        for (int index = 0; index < args.length; index++) {
            Object value = args[index];
            int position = index + 1;
            if (value == null) {
                query.bindNull(position);
            } else if (value instanceof Long) {
                query.bindLong(position, ((Long) value).longValue());
            } else if (value instanceof Double) {
                query.bindDouble(position, ((Double) value).doubleValue());
            } else {
                query.bindString(position, (String) value);
            }
        }
    }

    private static Object columnValue(Cursor cursor, int index) throws PluginFailure {
        switch (cursor.getType(index)) {
            case Cursor.FIELD_TYPE_NULL:
                return JSONObject.NULL;
            case Cursor.FIELD_TYPE_INTEGER:
                return Long.valueOf(cursor.getLong(index));
            case Cursor.FIELD_TYPE_FLOAT:
                double real = cursor.getDouble(index);
                if (!Double.isFinite(real)) {
                    throw new PluginFailure("non-finite REAL column");
                }
                return Double.valueOf(real);
            case Cursor.FIELD_TYPE_STRING:
                return cursor.getString(index);
            case Cursor.FIELD_TYPE_BLOB:
                throw new PluginFailure("BLOB columns are not returned");
            default:
                throw new PluginFailure("The request is not allowed.");
        }
    }

    private static String sqlFailure(android.database.SQLException ex) {
        String message = ex.getMessage();
        if (message == null || message.isEmpty()) {
            return "The request is not allowed.";
        }
        return message;
    }

    private File blobFile(String publicKey, String hash) throws PluginFailure {
        requirePublicKey(publicKey);
        if (!isHex(hash, 64)) {
            throw new PluginFailure("The file hash did not match.");
        }
        return new File(new File(new File(filesDir(), "profiles"), publicKey), "blobs/" + hash);
    }

    private File downloadFile(String publicKey, String relativePath) throws PluginFailure, IOException {
        requirePublicKey(publicKey);
        if (relativePath == null || relativePath.isEmpty() || relativePath.indexOf('\\') >= 0 || relativePath.charAt(0) == '/') {
            throw new PluginFailure("That path is not allowed.");
        }
        File root = new File(new File(filesDir(), "profiles"), publicKey + "/downloads");
        if (!root.isDirectory() && !root.mkdirs()) {
            throw new PluginFailure("The folder is not available.");
        }
        root = root.getCanonicalFile();
        File path = root;
        for (String segment : relativePath.split("/", -1)) {
            if (segment.isEmpty() || ".".equals(segment) || "..".equals(segment)) {
                throw new PluginFailure("That path is not allowed.");
            }
            path = new File(path, segment);
        }
        if (!isUnder(root, path.getCanonicalFile())) {
            throw new PluginFailure("That path is not allowed.");
        }
        return path;
    }

    private static void writeFile(File path, byte[] bytes) throws PluginFailure, IOException {
        File parent = path.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new PluginFailure("The folder is not available.");
        }
        try (FileOutputStream out = new FileOutputStream(path)) {
            out.write(bytes);
        }
    }

    private void collect(File root, File dir, List<SharedFile> files) throws PluginFailure, IOException {
        File[] children = dir.listFiles();
        if (children == null) {
            throw new PluginFailure("The folder is not available.");
        }
        for (File child : children) {
            if (isSymlink(child)) {
                continue;
            }
            if (child.isDirectory()) {
                collect(root, child, files);
                continue;
            }
            if (!child.isFile()) {
                continue;
            }
            if (files.size() >= MAX_FILES) {
                throw new PluginFailure("The folder has too many files.");
            }
            if (child.length() > MAX_BYTES) {
                throw new PluginFailure("The file is too large.");
            }
            File canonical = child.getCanonicalFile();
            if (!isUnder(root.getCanonicalFile(), canonical)) {
                throw new PluginFailure("That path is not allowed.");
            }
            String relative = canonical.getPath().substring(root.getCanonicalPath().length() + 1).replace('\\', '/');
            if (relative.isEmpty() || relative.contains("..")) {
                throw new PluginFailure("That path is not allowed.");
            }
            files.add(new SharedFile(relative, readLimited(canonical, MAX_BYTES)));
        }
    }

    private static boolean isSymlink(File file) throws IOException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return java.nio.file.Files.isSymbolicLink(file.toPath());
        }
        return !file.getCanonicalPath().equals(file.getAbsolutePath());
    }

    private static boolean isUnder(File root, File candidate) {
        String rootPath = root.getPath();
        String candidatePath = candidate.getPath();
        return candidatePath.equals(rootPath) || candidatePath.startsWith(rootPath + File.separator);
    }

    private static byte[] readLimited(File file, int max) throws PluginFailure, IOException {
        if (file.length() > max) {
            throw new PluginFailure("The file is too large.");
        }
        try (FileInputStream in = new FileInputStream(file)) {
            return readExact(in, (int) file.length());
        }
    }

    private static byte[] readByteArg(JSArray values) throws PluginFailure {
        if (values == null) {
            throw new PluginFailure("The request is not allowed.");
        }
        if (values.length() > MAX_BYTES) {
            throw new PluginFailure("The file is too large.");
        }
        byte[] bytes = new byte[values.length()];
        for (int index = 0; index < values.length(); index++) {
            Object value;
            try {
                value = values.get(index);
            } catch (JSONException ex) {
                throw new PluginFailure("The request is not allowed.");
            }
            if (!(value instanceof Number)) {
                throw new PluginFailure("The request is not allowed.");
            }
            double real = ((Number) value).doubleValue();
            if (!Double.isFinite(real) || real != Math.rint(real)) {
                throw new PluginFailure("The request is not allowed.");
            }
            int byteValue = (int) real;
            if (byteValue < 0 || byteValue > 255) {
                throw new PluginFailure("The request is not allowed.");
            }
            bytes[index] = (byte) byteValue;
        }
        return bytes;
    }

    private static JSArray byteArray(byte[] bytes) {
        JSArray listed = new JSArray();
        for (byte value : bytes) {
            listed.put(value & 0xff);
        }
        return listed;
    }

    private static byte[] readExact(InputStream in, int length) throws IOException {
        byte[] buffer = new byte[length];
        int offset = 0;
        while (offset < length) {
            int read = in.read(buffer, offset, length - offset);
            if (read < 0) {
                throw new IOException("closed");
            }
            offset += read;
        }
        return buffer;
    }

    private static String utf8(byte[] bytes) throws PluginFailure {
        try {
            CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
            return decoder.decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException ex) {
            throw new PluginFailure("The request is not allowed.");
        }
    }

    private static void requirePublicKey(String value) throws PluginFailure {
        if (!isHex(value, 64)) {
            throw new PluginFailure("Public key must be 64 lowercase hex characters");
        }
    }

    private static boolean isHex(String value, int length) {
        if (value == null || value.length() != length) {
            return false;
        }
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            boolean digit = character >= '0' && character <= '9';
            boolean lower = character >= 'a' && character <= 'f';
            if (!digit && !lower) {
                return false;
            }
        }
        return true;
    }

    private static final class SharedFile {
        private final String path;
        private final byte[] bytes;

        private SharedFile(String path, byte[] bytes) {
            this.path = path;
            this.bytes = bytes;
        }
    }

    private static final class PluginFailure extends Exception {
        private PluginFailure(String message) {
            super(message);
        }
    }
}
