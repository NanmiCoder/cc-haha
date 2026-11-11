package com.cchaha.mobile;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class ComputerRecordsTest {
  @Test public void migratesOldArrayAndStripsPairingSecrets() throws Exception {
    ComputerRecords records = new ComputerRecords("[{\"name\":\"Old Mac\",\"url\":\"https://MAC.test:443/remote#pair=abcdefghijklmnop\",\"extra\":{\"keep\":true}}]");
    JSONObject result = new JSONObject(records.serialize());
    assertEquals(3, result.getInt("version"));
    assertEquals("https://mac.test", records.computers().getJSONObject(0).getString("origin"));
    assertTrue(records.computers().getJSONObject(0).getJSONObject("extra").getBoolean("keep"));
    assertFalse(records.serialize().contains("abcdefghijklmnop"));
  }
  @Test public void deduplicatesOriginsPreservingUnknownFieldsAndNames() throws Exception {
    ComputerRecords records = new ComputerRecords("{\"rootExtra\":42,\"computers\":[{\"url\":\"https://mac.test/remote\",\"name\":\"Mine\",\"customName\":true},{\"url\":\"https://MAC.test:443/remote\",\"futureFlag\":true}]}");
    assertEquals(1, records.computers().length());
    assertEquals(42, new JSONObject(records.serialize()).getInt("rootExtra"));
    assertEquals("Mine", records.computers().getJSONObject(0).getString("name"));
    assertTrue(records.computers().getJSONObject(0).getBoolean("futureFlag"));
    assertEquals(records.serialize(), new ComputerRecords(records.serialize()).serialize());
  }
  @Test public void rescanDoesNotOverwriteCustomNameOrDuplicateComputer() throws Exception {
    ComputerRecords records = new ComputerRecords("{}");
    records.add(RemoteUrl.parse("https://mac.test/remote"), "My computer");
    records.add(RemoteUrl.parse("https://MAC.test:443/remote#pair=abcdefghijklmnop"), "Other");
    assertEquals(1, records.computers().length());
    assertEquals("My computer", records.computers().getJSONObject(0).getString("name"));
    assertFalse(records.serialize().contains("pair"));
  }
  @Test public void temporaryAddressChangeCreatesDistinctComputerAndPortIsPartOfIdentity() throws Exception {
    ComputerRecords records = new ComputerRecords("{}");
    for (String address : new String[] { "https://old.trycloudflare.com", "https://new.trycloudflare.com", "https://new.trycloudflare.com:8443" }) records.add(RemoteUrl.parse(address + "/remote"), address);
    assertEquals(3, records.computers().length());
    assertNotEquals(BrowserProfiles.key("https://host"), BrowserProfiles.key("https://host:8443"));
  }
  @Test public void renameAndRemoveOnlyAffectTarget() throws Exception {
    ComputerRecords records = new ComputerRecords("{\"unknown\":true}");
    records.add(RemoteUrl.parse("https://a.test/remote"), "A");
    records.add(RemoteUrl.parse("https://b.test/remote"), "B");
    records.rename("https://a.test", "New");
    assertEquals("New", records.computers().getJSONObject(0).getString("name"));
    records.remove("https://a.test");
    assertEquals("B", records.computers().getJSONObject(0).getString("name"));
    assertTrue(new JSONObject(records.serialize()).getBoolean("unknown"));
  }
  @Test public void malformedStoreFailsWithoutReplacingOriginal() {
    for (String bad : new String[] { "{not-json", "null", "42", "\"wrong\"" }) {
      try { new ComputerRecords(bad); fail("Expected corruption error"); } catch (Exception expected) { }
    }
  }
  @Test public void removesUnsafeOldConnectionAndPreservesUnknownFields() throws Exception {
    ComputerRecords records = new ComputerRecords("{\"version\":0,\"future\":\"kept\",\"computers\":[{\"url\":\"http://unsafe.test/remote\"}]}");
    assertEquals(0, records.computers().length());
    assertEquals(3, new JSONObject(records.serialize()).getInt("version"));
    assertEquals("kept", new JSONObject(records.serialize()).getString("future"));
  }
  @Test public void futureVersionFailsClosed() {
    try { new ComputerRecords("{\"version\":4,\"future\":\"keep\"}"); fail("Expected future version rejection"); }
    catch (Exception expected) { assertEquals("unsupported_computer_store_version", expected.getMessage()); }
  }
  @Test public void oldFixtureGetsEmptyDeletionQueueWithoutLosingFields() throws Exception {
    ComputerRecords records = new ComputerRecords("{\"version\":1,\"unknown\":7,\"computers\":[{\"origin\":\"https://old.test\",\"name\":\"Old\"}]}");
    assertTrue(records.pendingProfileDeletions().isEmpty());
    assertEquals(1, records.computers().length());
    records.setPendingProfileDeletion("https://old.test", true);
    ComputerRecords restarted = new ComputerRecords(records.serialize());
    assertTrue(restarted.pendingProfileDeletions().contains("https://old.test"));
    restarted.setPendingProfileDeletion("https://old.test", false);
    assertTrue(restarted.pendingProfileDeletions().isEmpty());
    assertEquals(7, new JSONObject(restarted.serialize()).getInt("unknown"));
  }

  @Test public void legacyUpgradePreservesNamesUnknownFieldsAndOldProfileForCleanup() throws Exception {
    ProtocolFixture fixture = new ProtocolFixture();
    ComputerRecords records = new ComputerRecords("{\"version\":1,\"future\":9,\"computers\":[{\"origin\":\"https://old.test\",\"name\":\"Mine\",\"customName\":true,\"unknown\":42}]}");
    JSONObject old = records.computers().getJSONObject(0);
    assertFalse(ComputerRecords.isBound(old));
    String legacyProfile = ComputerRecords.profileName(old);
    JSONObject upgraded = records.add(RemoteUrl.parse(fixture.qr("https://old.test")), "Other");
    assertSame(old, upgraded);
    assertTrue(ComputerRecords.isBound(upgraded));
    assertEquals("Mine", upgraded.getString("name"));
    assertEquals(42, upgraded.getInt("unknown"));
    assertEquals(9, new JSONObject(records.serialize()).getInt("future"));
    assertTrue(ComputerRecords.profiles(upgraded).contains(legacyProfile));
    assertNotEquals(legacyProfile, ComputerRecords.profileName(upgraded));
    assertFalse(records.serialize().contains("abcdefghijklmnop"));
    assertEquals(records.serialize(), new ComputerRecords(records.serialize()).serialize());
  }
  @Test public void sameIdentityChangesOriginWithoutDuplicatingComputerAndKeepsAllProfiles() throws Exception {
    ProtocolFixture fixture = new ProtocolFixture();
    ComputerRecords records = new ComputerRecords("{}");
    JSONObject record = records.add(RemoteUrl.parse(fixture.qr("https://old.test")), "Mine");
    String first = ComputerRecords.profileName(record);
    assertSame(record, records.add(RemoteUrl.parse(fixture.qr("https://new.test")), "New"));
    assertEquals("https://old.test", record.getString("origin"));
    records.connected(record, new ReconnectClient.Result(SessionProbe.State.ONLINE, "https://new.test", 10, RemoteProtocol.nonce(), null, "Mac"));
    assertEquals(1, records.computers().length());
    assertEquals("https://new.test", record.getString("origin"));
    assertEquals(2, ComputerRecords.profiles(record).size());
    assertTrue(ComputerRecords.profiles(record).contains(first));
    assertThrows(IllegalArgumentException.class, () -> records.connected(record, new ReconnectClient.Result(SessionProbe.State.ONLINE, "https://old.test", 9, null, null, null)));
    assertThrows(IllegalArgumentException.class, () -> records.add(RemoteUrl.parse(fixture.qr("https://new.test").replace("directory.test", "attacker.test")), "Changed"));
  }
  @Test public void deletionQueueSurvivesRestartAndUnknownDataIsPreserved() throws Exception {
    ComputerRecords records = new ComputerRecords("{\"version\":1,\"future\":42}");
    String profile = BrowserProfiles.key("host", "https://old.test");
    records.setPendingProfileName(profile, true);
    ComputerRecords restarted = new ComputerRecords(records.serialize());
    assertTrue(restarted.pendingProfileNames().contains(profile));
    assertEquals(42, new JSONObject(restarted.serialize()).getInt("future"));
    restarted.setPendingProfileName(profile, false);
    assertTrue(restarted.pendingProfileNames().isEmpty());
  }

  @Test public void versionTwoUniqueBoundComputerMigratesToResumeWithoutLosingUnknownData() throws Exception {
    ProtocolFixture fixture = new ProtocolFixture();
    JSONObject old = new JSONObject().put("version", 2).put("future", new JSONObject().put("keep", true))
        .put("computers", new org.json.JSONArray().put(fixture.record("https://old.test", true)));
    ComputerRecords migrated = new ComputerRecords(old.toString());
    assertEquals(fixture.hostId, ComputerRecords.id(migrated.lastComputer()));
    assertEquals(3, new JSONObject(migrated.serialize()).getInt("version"));
    assertTrue(new JSONObject(migrated.serialize()).getJSONObject("future").getBoolean("keep"));
    assertEquals(migrated.serialize(), new ComputerRecords(migrated.serialize()).serialize());
  }
  @Test public void temporaryOriginsNeverBecomeAutomaticColdLaunchTargets() throws Exception {
    ComputerRecords old = new ComputerRecords("{\"version\":2,\"lastComputerId\":\"legacy:https://old.test\",\"computers\":[{\"origin\":\"https://old.test\",\"name\":\"Old\"}]}");
    assertNull(old.lastComputer());
    old.opened(old.computers().getJSONObject(0));
    assertNull(new ComputerRecords(old.serialize()).lastComputer());
  }
  @Test public void migrationDoesNotGuessBetweenTwoComputersButRemembersActualSelection() throws Exception {
    ProtocolFixture fixture = new ProtocolFixture();
    java.security.KeyPairGenerator keys = java.security.KeyPairGenerator.getInstance("RSA");
    keys.initialize(2048);
    String secondKey = RemoteProtocol.encode(keys.generateKeyPair().getPublic().getEncoded());
    ComputerRecords seed = new ComputerRecords("{}");
    JSONObject first = seed.add(RemoteUrl.parse(fixture.qr("https://first.test")), "First");
    JSONObject second = seed.add(RemoteUrl.parse(fixture.qr("https://second.test").replace(fixture.publicKey, secondKey)), "Second");
    JSONObject old = new JSONObject(seed.serialize()).put("version", 2);
    old.remove("lastComputerId");
    ComputerRecords migrated = new ComputerRecords(old.toString());
    assertNull(migrated.lastComputer());
    migrated.opened(migrated.find(ComputerRecords.id(second)));
    ComputerRecords restarted = new ComputerRecords(migrated.serialize());
    assertEquals(ComputerRecords.id(second), ComputerRecords.id(restarted.lastComputer()));
    restarted.connected(restarted.find(ComputerRecords.id(first)), new ReconnectClient.Result(SessionProbe.State.ONLINE, "https://first.test", 1, null, null, null));
    assertEquals("A background health check must not change selection", ComputerRecords.id(second), ComputerRecords.id(restarted.lastComputer()));
    restarted.remove(ComputerRecords.id(second));
    assertNull(new ComputerRecords(restarted.serialize()).lastComputer());
    assertNotNull(restarted.find(ComputerRecords.id(first)));
  }
}
