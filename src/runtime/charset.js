// The charset scan behind import delimited's "(encoding automatically
// selected: ...)" line. Stata 19 runs ICU's charset detector (ICU 69, built
// into Stata) on the first 8,000 bytes of the file and, among the encodings
// that share the highest confidence, names the last in ICU's order of
// recognizers. Both rules were recorded from Stata 19 on simulated files:
// an invalid byte at offset 7,999 changes the choice and one at 8,000 does
// not, and on 119 files the name matched the last of ICU's tied leaders.
//
// What follows is a port of ICU's detector (icu4c/source/i18n/csdetect.cpp,
// csrutf8.cpp, csrucode.cpp, csrsbcs.cpp, csrmbcs.cpp, csr2022.cpp and
// inputext.cpp), with its tables of common three-letter sequences and
// characters copied as they are. ICU is © 2016 and later Unicode, Inc. and
// others, and © 2005-2016 International Business Machines Corporation and
// others, under the Unicode license (https://www.unicode.org/copyright.html).

/** How much of the file Stata hands to the detector. */
export const SAMPLE = 8000;
// ICU looks at no more than this much of the sample for the single-byte
// and ISO-2022 encodings.
const BUFFER = 8192;

// ICU's 256-byte maps of each byte to the letter it is counted as.
const CHAR_MAPS = {
  "8859_1":
    "202020202020202020202020202020202020202020202020202020202020202020202020" +
    "202020002020202020202020202020202020202020202020202020202061626364656667" +
    "68696a6b6c6d6e6f707172737475767778797a2020202020206162636465666768696a6b" +
    "6c6d6e6f707172737475767778797a202020202020202020202020202020202020202020" +
    "2020202020202020202020202020202020202020202020202020aa202020202020202020" +
    "20b520202020ba2020202020e0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f620" +
    "f8f9fafbfcfdfedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f620f8f9fafb" +
    "fcfdfeff",
  "8859_2":
    "202020202020202020202020202020202020202020202020202020202020202020202020" +
    "202020002020202020202020202020202020202020202020202020202061626364656667" +
    "68696a6b6c6d6e6f707172737475767778797a2020202020206162636465666768696a6b" +
    "6c6d6e6f707172737475767778797a202020202020202020202020202020202020202020" +
    "2020202020202020202020202020202020b120b320b5b62020b9babbbc20bebf20b120b3" +
    "20b5b6b720b9babbbc20bebfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f620" +
    "f8f9fafbfcfdfedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f620f8f9fafb" +
    "fcfdfe20",
  "8859_5":
    "202020202020202020202020202020202020202020202020202020202020202020202020" +
    "202020002020202020202020202020202020202020202020202020202061626364656667" +
    "68696a6b6c6d6e6f707172737475767778797a2020202020206162636465666768696a6b" +
    "6c6d6e6f707172737475767778797a202020202020202020202020202020202020202020" +
    "2020202020202020202020202020202020f1f2f3f4f5f6f7f8f9fafbfc20feffd0d1d2d3" +
    "d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeefd0d1d2d3d4d5d6d7" +
    "d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeef20f1f2f3f4f5f6f7f8f9fafb" +
    "fc20feff",
  "8859_6":
    "202020202020202020202020202020202020202020202020202020202020202020202020" +
    "202020002020202020202020202020202020202020202020202020202061626364656667" +
    "68696a6b6c6d6e6f707172737475767778797a2020202020206162636465666768696a6b" +
    "6c6d6e6f707172737475767778797a202020202020202020202020202020202020202020" +
    "202020202020202020202020202020202020202020202020202020202020202020202020" +
    "20202020202020202020202020c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7" +
    "d8d9da2020202020e0e1e2e3e4e5e6e7e8e9ea2020202020202020202020202020202020" +
    "20202020",
  "8859_7":
    "202020202020202020202020202020202020202020202020202020202020202020202020" +
    "202020002020202020202020202020202020202020202020202020202061626364656667" +
    "68696a6b6c6d6e6f707172737475767778797a2020202020206162636465666768696a6b" +
    "6c6d6e6f707172737475767778797a202020202020202020202020202020202020202020" +
    "2020202020202020202020202020202020a1a22020202020202020202020202020202020" +
    "2020dc20dddedf20fc20fdfec0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f120f3f4f5f6f7" +
    "f8f9fafbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafb" +
    "fcfdfe20",
  "8859_8":
    "202020202020202020202020202020202020202020202020202020202020202020202020" +
    "202020002020202020202020202020202020202020202020202020202061626364656667" +
    "68696a6b6c6d6e6f707172737475767778797a2020202020206162636465666768696a6b" +
    "6c6d6e6f707172737475767778797a202020202020202020202020202020202020202020" +
    "202020202020202020202020202020202020202020202020202020202020202020202020" +
    "20b520202020202020202020202020202020202020202020202020202020202020202020" +
    "2020202020202020e0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fa20" +
    "20202020",
  "8859_9":
    "202020202020202020202020202020202020202020202020202020202020202020202020" +
    "202020002020202020202020202020202020202020202020202020202061626364656667" +
    "68696a6b6c6d6e6f707172737475767778797a2020202020206162636465666768696a6b" +
    "6c6d6e6f707172737475767778797a202020202020202020202020202020202020202020" +
    "2020202020202020202020202020202020202020202020202020aa202020202020202020" +
    "20b520202020ba2020202020e0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f620" +
    "f8f9fafbfc69fedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f620f8f9fafb" +
    "fcfdfeff",
  windows_1251:
    "202020202020202020202020202020202020202020202020202020202020202020202020" +
    "202020002020202020202020202020202020202020202020202020202061626364656667" +
    "68696a6b6c6d6e6f707172737475767778797a2020202020206162636465666768696a6b" +
    "6c6d6e6f707172737475767778797a2020202020908320832020202020209a209c9d9e9f" +
    "902020202020202020209a209c9d9e9f20a2a2bc20b42020b820ba20202020bf2020b3b3" +
    "b4b52020b820ba20bcbebebfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7" +
    "f8f9fafbfcfdfeffe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafb" +
    "fcfdfeff",
  windows_1256:
    "202020202020202020202020202020202020202020202020202020202020202020202020" +
    "202020002020202020202020202020202020202020202020202020202061626364656667" +
    "68696a6b6c6d6e6f707172737475767778797a2020202020206162636465666768696a6b" +
    "6c6d6e6f707172737475767778797a2020202020208120832020202088208a209c8d8e8f" +
    "902020202020202098209a209c20209f20202020202020202020aa202020202020202020" +
    "20b520202020202020202020c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d620" +
    "d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeef20202020f420202020f920fb" +
    "fc2020ff",
  KOI8_R:
    "202020202020202020202020202020202020202020202020202020202020202020202020" +
    "202020002020202020202020202020202020202020202020202020202061626364656667" +
    "68696a6b6c6d6e6f707172737475767778797a2020202020206162636465666768696a6b" +
    "6c6d6e6f707172737475767778797a202020202020202020202020202020202020202020" +
    "20202020202020202020202020202020202020a3202020202020202020202020202020a3" +
    "202020202020202020202020c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7" +
    "d8d9dadbdcdddedfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadb" +
    "dcdddedf",
};
// ICU's 64 most common three-letter sequences of each language.
const NGRAMS = {
  "8859_1": [
    [
      "en",
      "20612020616e20626520636f20666f20686120686520696e206d61206f66207072207265" +
        "20736120737420746820746f207768616964616c20616e20616e64617320617420617465" +
        "617469642061642074652061652073652074656420656e74657220657320666f72686174" +
        "686520686572696420696e20696e67696f6e6973206e20616e20746e64206e67206e7420" +
        "6f66206f6e206f7220726520727320732061732074736169737420742074746572746861" +
        "74686574696f746f20747320",
    ],
    [
      "da",
      "20616620617420646520656e20657220666f206861206920206d65206f672070e5207369" +
        "207374207469207669616620616e20616e6461722061742064652064656e646572646574" +
        "652073656420656465656e20656e64657220657265657320657420666f7267652067656e" +
        "676572696765696c20696e676b65206b6b656c65726c69676c6c656d65646e64656e6520" +
        "6e67206e67656f67206f6d206f722070e520722064722065722073726520737465742073" +
        "74652074657274696c766572",
    ],
    [
      "de",
      "20616e20617520626520646120646520646920656920676520686120696e206d69207363" +
        "20736520756e20766520766f207765207a7562657263682063686563687464617364656e" +
        "64657264696565206465207365696e656974656e2065722065732067656e68656e687420" +
        "696368696520696e20696e656974206c69636c6c656e20616e20646e20736e64206e6465" +
        "6e65206e67206e67656e746572206472646572656973636873746574206474652074656e" +
        "746572756e64756e67766572",
    ],
    [
      "es",
      "20612020636120636f20646520656c20656e20657320696e206c61206c6f20706120706f" +
        "20707220717520726520736520756e20792061206361206461206561206c612070616369" +
        "61646f616c206172206173206369f3636f6e64652064656c646f2065206465206565206c" +
        "656c20656e20656e7465732065737469656e69f36e6c61206c6f736e20656e74656f2064" +
        "6f20656f6e206f72206f7320706172717565726120726573732064732065732070736520" +
        "746520746f20756520f36e20",
    ],
    [
      "fr",
      "20617520636f20646120646520647520656e206574206c61206c6520706120706f207072" +
        "20717520736520736f20756e20e020616e74617469636520636f6e646520646573647520" +
        "65206165206365206465206565206c652070652073656e20656e74657220657320657420" +
        "657572696f6e6973206974206c61206c65206c65736d656e6e20646e65206e73206e7420" +
        "6f6e206f6e746f757271756572206c72652073206173206473206573206c732070742064" +
        "74652074696f756520757220",
    ],
    [
      "it",
      "20616c20636820636f20646520646920652020696c20696e206c6120706520707220756e" +
        "61206361206461207061207361746f636865636f6e64656c646920652061652063652064" +
        "65206965206c652070652073656c20656c6c656e74657220686520692061692063692064" +
        "692073696120696c20696e20696f6e6c61206c65206c69206c6c616e65206e69206e6f20" +
        "6e74656f20616f20646f20696f20736f6e206f6e65706572726120726520736920746120" +
        "746520746920746f207a696f",
    ],
    [
      "nl",
      "20616c20626520646120646520646920656520656e20676520686520696e206d61206d65" +
        "206f7020746520766120766520766f207765207a6961616e616172616e20616e64617220" +
        "61742063687464652064656e64657265206265207665656e656572656e20657220657273" +
        "65742067656e686574696520696e20696e676973206e20626e20646e20656e20686e206f" +
        "6e20766e64656e67206f6e646f6f726f70206f722073636873746574206474652074656e" +
        "74657276616e766572766f6f",
    ],
    [
      "no",
      "20617420617620646520656e20657220666f206861206920206d65206f672070e5207365" +
        "20736b20736f20737420746920766920e520616e6461722061742064652064656e646574" +
        "652073656420656e20656e65657220657265657420657474666f7267656e696b6b696c20" +
        "696e676b65206b6b656c65206c6c656d65646d656e6e20736e65206e67206e67656e6e65" +
        "6f67206f6d206f722070e520722073726520736f6d73746574207374652074656e746572" +
        "74696c747420747465766572",
    ],
    [
      "pt",
      "20612020636f20646120646520646f206520206573206d61206e6f206f2020706120706f" +
        "20707220717520726520736520756d61206161206361206461207061646561646f616c20" +
        "617220617261617320636f6d636f6e646120646520646f20646f73652061652064656d20" +
        "656e746573206573746961206963616d656e6e74656e746f6f20616f20636f20646f2065" +
        "6f20706f7320706172717565726120726573732061732064732065732070737461746520" +
        "746f20756520e36f20e7e36f",
    ],
    [
      "sv",
      "20617420617620646520656e2066f620686120692020696e206b6f206d65206f632070e5" +
        "20736b20736f20737420746920766120766920e472616465616e20616e64617220617474" +
        "63682064652064656e646572646574656420656e2065722065742066f67267656e696c6c" +
        "696e676b61206c6c206d65646e20736e61206e64656e67206e67656e696e6f63686f6d20" +
        "6f6e2070e520722061722073726120736b61736f6d74207374612074652074657274696c" +
        "747420766172e47220f67220",
    ],
  ],
  "8859_2": [
    [
      "cs",
      "20612020627920646f206a65206e61206e65206f20206f6420706f2070722070f820726f" +
        "20736520736f20737420746f207620207679207a61612070636520636820652070652073" +
        "652076656d20656eed686f20686f646973746a65206b74656c65206c69206e61206ee920" +
        "6eec206eed206f20706f646e6f6a696f73746f75206f7661706f64706f6a70726f70f865" +
        "736520736f7573746173746973746e746572746eed746f20752070be6520e16eede9686f" +
        "ed2070ed2073ed6d20f86564",
    ],
    [
      "hu",
      "20612020617a20626520656720656c20666520686120686f206973206b65206b69206bf6" +
        "206c65206d61206d65206d69206e6520737a20746520e97361206161206b61206d612073" +
        "616b20616e20617a2062616e62656e656779656b20656c20656c65656d20656e20657265" +
        "657420657465657474677920686f67696e746973206b20616bf67a6d65676d696e6e2061" +
        "6e616b6e656b6e656d6e74206f6779732061737a65737a74737ae173e967742061747420" +
        "74e1737a6572e16e20e97320",
    ],
    [
      "pl",
      "20637a20646f206920206a65206b6f206d61206d69206e61206e69206f6420706f207072" +
        "207369207720207769207779207a20207a61612070612077616e69636820637a65637a79" +
        "646f20647a6965207065207365207765207a65676f656a20656d20656e69676f20696120" +
        "69652069656a6b61206b69206b69656d69656e61206e69616e69656f20706f77616f7769" +
        "706f6c70726170726f70727a727a65727a797369ea736b69737461776965796368796d20" +
        "7a65207a69657a7920f37720",
    ],
    [
      "ro",
      "20612020616320636120636520636f206375206465206469206c61206d61207065207072" +
        "2073652073e320756e20ba6920ee6e612063612064617265617420617465617520636172" +
        "636f6e63752063e320646520652061652063652064652070652073656120656920656c65" +
        "656e74657374692061692063692064692070696520696920696e206c61206c65206c6f72" +
        "6c75696e65206e74726f722070656e72652072656172752073e32074652074727574e320" +
        "756920756c20ba6920ee6e20",
    ],
  ],
  "8859_5_ru":
    "20d22020d2de20d4de20d7d020d82020dad020dade20ddd020ddd520ded120dfde20dfe0" +
    "20e0d020e1de20e1e220e2de20e7e220ede2d0ddd8d0e2ecd3de20d5dbecd5ddd8d5e1e2" +
    "d5e220d820dfd8d520d8d820d8ef20dbd5dddbd820dbecddddd020ddd520ddd8d5ddd8ef" +
    "ddde20ddded2de20d2de20dfde20e1ded220ded2d0ded3deded920dedbecdedc20dee1e2" +
    "dfdedbdfe0d5dfe0d8dfe0dee0d0d2e0d5d4e1e2d0e1e2d2e1e2d8e1ef20e2d5dbe2de20" +
    "e2dee0e2ec20e7e2deebe520",
  "8859_6_ar":
    "20c7e420c7e620c8c720d9e420e1ea20e4e420e5e620e8c7c720c7c7c120c7ca20c7d120" +
    "c7e420c7e4c3c7e4c7c7e4c8c7e4cac7e4ccc7e4cdc7e4cfc7e4d3c7e4d9c7e4e2c7e4e5" +
    "c7e4e8c7e4eac7e520c7e620c7e6cac820c7c920c7c920e1c920e4c920e5c920e8ca20c7" +
    "cf20c7cfc920d120c7d1c920d320c7d920c7d9e4e9e1ea20e420c7e4c920e4e920e4ea20" +
    "e520c7e5c720e5c920e5e620e620c7e720c7e7c720e8c7e4e8e620e920c7ea20c7ea20e5" +
    "ea20e8eac920ead120eae620",
  "8859_7_el":
    "20e1ed20e1f020e3e920e4e920e5f020e72020eae120ece520ede120ef2020f0e120f0ef" +
    "20f0f120f3f420f3f520f4e720f4efdfe120e120e1e120f4e1e920e1ed20e1f0fce1f220" +
    "e3e9e1e5e920e5f220e720f4e7ed20e7f220e920f4e9e120e9eadee9f220eae1e9eae1f4" +
    "ece520ed20e1ed20e5ed20f0ede120eff220eff520f0eff5f0f1eff0fc20f220e1f220e5" +
    "f220eaf220f0f220f4f3e520f3e720f3f4eff4e120f4e1e9f4e7edf4e7f2f4e9eaf4ef20" +
    "f4eff5f4f9edf9ed20feed20",
  "8859_8_I_he":
    "20e0e520e0e720e0e920e0fa20e1e920e1ee20e4e020e4e520e4e920e4ee20e4f220e4f9" +
    "20e4fa20ece020ece420eee020f2ec20f9ece0fa20e420e0e420e1e420e4e420ece420ee" +
    "e420f9e4e5e0e5e020e5ed20e5ef20e5f820e5fa20e920e4e9e420e9e5fae9e9ede9ed20" +
    "e9ef20e9f820e9fa20ec20e0ec20e4ece020ece420ed20e0ed20e1ed20e4ed20eced20ee" +
    "ed20f9eee420ef20e4f0e420f0e920f0e9edf2ec20f820e4f8e9edf9ec20fa20e0fa20e1" +
    "fa20e4fa20ecfa20eefa20f9",
  "8859_8_he":
    "20e0e520e0ec20e4e920e4ec20e4ee20e4f020e9f020ecf220ecf920ede520ede920efe5" +
    "20efe920f8e520f8e920fae020fae520fae9e020e4e020ece020ede020fae0e420e0e5e4" +
    "e0ec20e0ee20e120e4e120ede120fae420e4e420e9e420ece420ede420efe420f8e420fa" +
    "e4ec20e5e020e5e420e7e020e9e020e9e120e9e420ec20e4ec20edec20faecf220ecf920" +
    "ede9e9ede9f0ede9f8ee20e4ee20edee20faeee120eee420f2e420f920e4f920edf920fa" +
    "f9e420fae020fae420fae5e9",
  "8859_9_tr":
    "20626120626920627520646120646520676520686120696c206b61206b6f206d61206f6c" +
    "207361207461207665207961612062616b20616c61616d61616e20616efd617220617261" +
    "6172fd6173fd61796162697264612064652064692065206265206b656469656e20657220" +
    "657269657369696c65696e20696e696972206c616e6c61726c65206c65726e20616e2062" +
    "6e206b6e64616e64656e65206e69206e696e6efd2072696e72fd6e766520796120796f72" +
    "fd6e20fd6e64fd6efdfdf0fd",
  windows_1251:
    "20e22020e2ee20e4ee20e7e020e82020eae020eaee20ede020ede520eee120efee20eff0" +
    "20f0e020f1ee20f1f220f2ee20f7f220fdf2e0ede8e0f2fce3ee20e5ebfce5ede8e5f1f2" +
    "e5f220e820efe8e520e8e820e8ff20ebe5edebe820ebfcedede020ede520ede8e5ede8ff" +
    "edee20edeee2ee20e2ee20efee20f1eee220eee2e0eee3eeeee920eeebfceeec20eef1f2" +
    "efeeebeff0e5eff0e8eff0eef0e0e2f0e5e4f1f2e0f1f2e2f1f2e8f1ff20f2e5ebf2ee20" +
    "f2eef0f2fc20f7f2eefbf520",
  windows_1256:
    "20c7e120c7e420c8c720dae120dded20e1e120e3e420e6c7c720c7c7c120c7ca20c7d120" +
    "c7e120c7e1c3c7e1c7c7e1c8c7e1cac7e1ccc7e1cdc7e1cfc7e1d3c7e1dac7e1dec7e1e3" +
    "c7e1e6c7e1edc7e320c7e420c7e4cac820c7c920c7c920ddc920e1c920e3c920e6ca20c7" +
    "cf20c7cfc920d120c7d1c920d320c7da20c7dae1ecdded20e120c7e1c920e1ec20e1ed20" +
    "e320c7e3c720e3c920e3e420e420c7e520c7e5c720e6c7e1e6e420ec20c7ed20c7ed20e3" +
    "ed20e6edc920edd120ede420",
  KOI8_R:
    "20c4cf20c92020cbc120cbcf20cec120cec520cfc220d0cf20d0d220d2c120d3cf20d3d4" +
    "20d4cf20d72020d7cf20dac120dcd420ded4c1cec9c1d4d8c5ccd8c5cec9c5d3d4c5d420" +
    "c7cf20c920d0c9c520c9c920c9d120ccc5ceccc920ccd8cecec120cec520cec9c5cec9d1" +
    "cecf20cecfd7cf20d0cf20d3cf20d7cfc7cfcfca20cfccd8cfcd20cfd3d4cfd720cfd7c1" +
    "d0cfccd0d2c5d0d2c9d0d2cfd2c1d7d2c5c4d3d120d3d4c1d3d4c9d3d4d7d4c5ccd4cf20" +
    "d4cfd2d4d820d9c820ded4cf",
};
// ICU's most common two-byte characters of each multi-byte encoding.
const COMMON = {
  sjis:
    "8140814181428145815b8169816a8175817682a082a282a482a982aa82ab82ad82af82b1" +
    "82b382b582b782bd82be82c182c482c582c682c882c982cc82cd82dc82e082e782e882e9" +
    "82ea82f082f183418343834e834f8358835e83628367837583768389838a838b838d8393" +
    "8e9693fa95aa",
  euc_jp:
    "a1a1a1a2a1a3a1a6a1bca1caa1cba1d6a1d7a4a2a4a4a4a6a4a8a4aaa4aba4aca4ada4af" +
    "a4b1a4b3a4b5a4b7a4b9a4bba4bda4bfa4c0a4c1a4c3a4c4a4c6a4c7a4c8a4c9a4caa4cb" +
    "a4cea4cfa4d0a4dea4dfa4e1a4e2a4e4a4e8a4e9a4eaa4eba4eca4efa4f2a4f3a5a2a5a3" +
    "a5a4a5a6a5a7a5aaa5ada5afa5b0a5b3a5b5a5b7a5b8a5b9a5bfa5c3a5c6a5c7a5c8a5c9" +
    "a5cba5d0a5d5a5d6a5d7a5dea5e0a5e1a5e5a5e9a5eaa5eba5eca5eda5f3b8a9b9d4baee" +
    "bbc8bef0bfb7c4eac6fcc7bdcab8caf3cbdccdd1",
  euc_kr:
    "b0a1b0b3b0c5b0cdb0d4b0e6b0edb0f8b0fab0fcb1b8b1b9b1c7b1d7b1e2b3aab3bbb4c2" +
    "b4cfb4d9b4ebb5a5b5b5b5bfb5c7b5e9b6f3b7afb7c2b7ceb8a6b8aeb8b6b8b8b8bbb8e9" +
    "b9abb9aeb9ccb9ceb9fdbab8bacebad0baf1bbe7bbf3bbfdbcadbcbabcd2bcf6bdbabdc0" +
    "bdc3bdc5bec6bec8bedfbeeebef8befabfa1bfa9bfc0bfe4bfebbfecbff8c0a7c0afc0b8" +
    "c0bac0bbc0bdc0c7c0ccc0cec0cfc0d6c0dac0e5c0fbc0fcc1a4c1a6c1b6c1d6c1dfc1f6" +
    "c1f8c4a1c5cdc6aec7cfc7d1c7d2c7d8c7e5c8ad",
  big5:
    "a140a141a142a143a147a149a175a176a440a446a447a448a451a454a457a464a46aa46c" +
    "a477a4a3a4a4a4a7a4c1a4cea4d1a4dfa4e8a4fda540a548a558a569a5cda5e7a657a661" +
    "a662a668a670a6a8a6b3a6b9a6d3a6dba6e6a6f2a740a751a759a7daa8a3a8a5a8ada8d1" +
    "a8d3a8e4a8fca9c0a9d2a9f3aa6baabaaabeaaccaafcac47ac4facb0acd2ad59aec9afe0" +
    "b0eab16fb2b3b2c4b36fb44cb44eb54cb5a5b5bdb5d0b5d8b671b7edb867b944bad8bb44" +
    "bba1bdd1c2c4c3b9c440c45f",
  gb_18030:
    "a1a1a1a2a1a3a1a4a1b0a1b1a1f1a1f3a3a1a3aca3bab1a8b1b8b1beb2bbb3c9b3f6b4f3" +
    "b5bdb5c4b5e3b6afb6d4b6e0b7a2b7a8b7bdb7d6b7ddb8b4b8dfb8f6b9abb9c9b9d8b9fa" +
    "b9fdbacdbba7bbd6bbe1bbfabcbcbcdbbcfebdccbecdbeddbfb4bfc6bfc9c0b4c0edc1cb" +
    "c2dbc3c7c4dcc4eac5ccc6f7c7f8c8abc8cbc8d5c8e7c9cfc9facab1cab5cac7cad0cad6" +
    "caf5cafdcceccdf8ceaacec4ced2cee5cfb5cfc2cfd6d0c2d0c5d0d0d0d4d1a7d2aad2b2" +
    "d2b5d2bbd2d4d3c3d3d0d3fdd4c2d4dad5e2d6d0",
};

const hexList = (text, width) => {
  const out = new Int32Array(text.length / width);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(text.slice(i * width, i * width + width), 16);
  return out;
};
const unpacked = new Map();
const table = (text, width) => {
  let list = unpacked.get(text);
  if (!list) unpacked.set(text, (list = hexList(text, width)));
  return list;
};

/** ICU's search of a sorted table of exactly 64 three-byte sequences. */
function search(list, value) {
  let index = 0;
  for (const step of [32, 16, 8, 4, 2, 1])
    if (list[index + step] <= value) index += step;
  if (list[index] > value) index--;
  return index >= 0 && list[index] === value;
}

/** The share of three-letter sequences found in a language's table. */
function ngramConfidence(input, ngramText, mapText) {
  const list = table(ngramText, 6),
    map = table(mapText, 2);
  let ngram = 0,
    count = 0,
    hits = 0,
    ignoreSpace = false;
  const add = (b) => {
    ngram = ((ngram << 8) + b) & 0xffffff;
    count++;
    if (search(list, ngram)) hits++;
  };
  for (const byte of input) {
    const mb = map[byte];
    if (mb !== 0) {
      if (!(mb === 0x20 && ignoreSpace)) add(mb);
      ignoreSpace = mb === 0x20;
    }
  }
  add(0x20);
  const raw = hits / count;
  return raw > 0.33 ? 98 : Math.trunc(raw * 300);
}

function utf8(raw) {
  const hasBOM =
    raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  let valid = 0,
    invalid = 0;
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    if ((b & 0x80) === 0) continue;
    let trail;
    if ((b & 0xe0) === 0xc0) trail = 1;
    else if ((b & 0xf0) === 0xe0) trail = 2;
    else if ((b & 0xf8) === 0xf0) trail = 3;
    else {
      invalid++;
      continue;
    }
    for (;;) {
      i++;
      if (i >= raw.length) break;
      if ((raw[i] & 0xc0) !== 0x80) {
        invalid++;
        break;
      }
      if (--trail === 0) {
        valid++;
        break;
      }
    }
  }
  if (hasBOM && invalid === 0) return 100;
  if (hasBOM && valid > invalid * 10) return 80;
  if (valid > 3 && invalid === 0) return 100;
  if (valid > 0 && invalid === 0) return 80;
  if (valid === 0 && invalid === 0) return 15;
  if (valid > invalid * 10) return 25;
  return 0;
}

function utf16(raw, little) {
  let confidence = 10;
  const length = raw.length,
    check = Math.min(length, 30);
  for (let i = 0; i < check - 1; i += 2) {
    const unit = little
      ? raw[i] | (raw[i + 1] << 8)
      : (raw[i] << 8) | raw[i + 1];
    if (i === 0 && unit === 0xfeff) {
      confidence =
        little && length >= 4 && raw[2] === 0 && raw[3] === 0 ? 0 : 100;
      break;
    }
    if (unit === 0) confidence -= 10;
    else if ((unit >= 0x20 && unit <= 0xff) || unit === 0x0a) confidence += 10;
    confidence = Math.max(0, Math.min(100, confidence));
    if (confidence === 0 || confidence === 100) break;
  }
  return check < 4 && confidence < 100 ? 0 : confidence;
}

function utf32(raw, little) {
  const limit = raw.length - (raw.length % 4),
    at = (i) =>
      little
        ? (raw[i + 3] << 24) | (raw[i + 2] << 16) | (raw[i + 1] << 8) | raw[i]
        : (raw[i] << 24) | (raw[i + 1] << 16) | (raw[i + 2] << 8) | raw[i + 3];
  let valid = 0,
    invalid = 0;
  const hasBOM = limit > 0 && at(0) === 0xfeff;
  for (let i = 0; i < limit; i += 4) {
    const ch = at(i);
    if (ch < 0 || ch >= 0x10ffff || (ch >= 0xd800 && ch <= 0xdfff)) invalid++;
    else valid++;
  }
  if (hasBOM && invalid === 0) return 100;
  if (hasBOM && valid > invalid * 10) return 80;
  if (valid > 3 && invalid === 0) return 100;
  if (valid > 0 && invalid === 0) return 80;
  if (valid > invalid * 10) return 25;
  return 0;
}

// The character readers of the multi-byte recognizers. Each returns the
// next character as { value, error }, or null at the end.
function reader(raw, kind) {
  let next = 0;
  const byte = () => (next < raw.length ? raw[next++] : -1);
  return () => {
    const first = byte();
    if (first < 0) return null;
    let value = first,
      error = false;
    if (kind === "sjis") {
      if (first <= 0x7f || (first > 0xa0 && first <= 0xdf))
        return { value, error };
      const second = byte();
      if (second >= 0) value = (first << 8) | second;
      if (!(
        (second >= 0x40 && second <= 0x7f) ||
        (second >= 0x80 && second <= 0xfe)
      ))
        error = true;
      return { value, error };
    }
    if (kind === "euc") {
      if (first <= 0x8d) return { value, error };
      const second = byte();
      if (second >= 0) value = (value << 8) | second;
      if (first >= 0xa1 && first <= 0xfe) {
        if (second < 0xa1) error = true;
        return { value, error };
      }
      if (first === 0x8e) {
        if (second < 0xa1) error = true;
        return { value, error };
      }
      if (first === 0x8f) {
        const third = byte();
        value = (value << 8) | third;
        if (third < 0xa1) error = true;
      }
      return { value, error };
    }
    if (kind === "big5") {
      if (first <= 0x7f || first === 0xff) return { value, error };
      const second = byte();
      if (second >= 0) value = (value << 8) | second;
      if (second < 0x40 || second === 0x7f || second === 0xff) error = true;
      return { value, error };
    }
    // GB18030. ICU compares the second byte with 80, not 0x80.
    if (first <= 0x80) return { value, error };
    const second = byte();
    if (second >= 0) value = (value << 8) | second;
    if (first >= 0x81 && first <= 0xfe) {
      if (
        (second >= 0x40 && second <= 0x7e) ||
        (second >= 80 && second <= 0xfe)
      )
        return { value, error };
      if (second >= 0x30 && second <= 0x39) {
        const third = byte();
        if (third >= 0x81 && third <= 0xfe) {
          const fourth = byte();
          if (fourth >= 0x30 && fourth <= 0x39) {
            value = (value << 16) | (third << 8) | fourth;
            return { value, error };
          }
        }
      }
      error = true;
    }
    return { value, error };
  };
}

function binarySearch(list, value) {
  let start = 0,
    end = list.length - 1,
    mid = (start + end) >> 1;
  while (start <= end) {
    if (list[mid] === value) return mid;
    if (list[mid] < value) start = mid + 1;
    else end = mid - 1;
    mid = (start + end) >> 1;
  }
  return -1;
}

function multiByte(raw, kind, commonText) {
  const common = table(commonText, 4),
    next = reader(raw, kind);
  let double = 0,
    commonCount = 0,
    bad = 0,
    total = 0;
  for (let c = next(); c; c = next()) {
    total++;
    if (c.error) bad++;
    // ICU keeps the low 16 bits when it looks a character up.
    else if (c.value > 0xff) {
      double++;
      if (binarySearch(common, c.value & 0xffff) >= 0) commonCount++;
    }
    if (bad >= 2 && bad * 5 >= double) return 0;
  }
  if (double <= 10 && bad === 0) return double === 0 && total < 10 ? 0 : 10;
  if (double < 20 * bad) return 0;
  const scale = 90 / Math.log(double / 4);
  const confidence = Math.min(
    Math.trunc(Math.log(commonCount + 1) * scale + 10),
    100,
  );
  return confidence < 0 ? 0 : confidence;
}

const ESCAPES = {
  jp: [
    [0x1b, 0x24, 0x28, 0x43],
    [0x1b, 0x24, 0x28, 0x44],
    [0x1b, 0x24, 0x40],
    [0x1b, 0x24, 0x41],
    [0x1b, 0x24, 0x42],
    [0x1b, 0x26, 0x40],
    [0x1b, 0x28, 0x42],
    [0x1b, 0x28, 0x48],
    [0x1b, 0x28, 0x49],
    [0x1b, 0x28, 0x4a],
    [0x1b, 0x2e, 0x41],
    [0x1b, 0x2e, 0x46],
  ],
  kr: [[0x1b, 0x24, 0x29, 0x43]],
  cn: [
    [0x1b, 0x24, 0x29, 0x41],
    [0x1b, 0x24, 0x29, 0x47],
    [0x1b, 0x24, 0x2a, 0x48],
    [0x1b, 0x24, 0x29, 0x45],
    [0x1b, 0x24, 0x2b, 0x49],
    [0x1b, 0x24, 0x2b, 0x4a],
    [0x1b, 0x24, 0x2b, 0x4b],
    [0x1b, 0x24, 0x2b, 0x4c],
    [0x1b, 0x24, 0x2b, 0x4d],
    [0x1b, 0x4e],
    [0x1b, 0x4f],
  ],
};
function iso2022(text, escapes) {
  let hits = 0,
    misses = 0,
    shifts = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === 0x1b) {
      let matched = false;
      for (const seq of escapes) {
        // ICU counts a sequence that runs past the end as no match.
        if (text.length - i < seq.length) continue;
        let j = 1;
        while (j < seq.length && seq[j] === text[i + j]) j++;
        if (j === seq.length) {
          hits++;
          i += seq.length - 1;
          matched = true;
          break;
        }
      }
      if (matched) continue;
      misses++;
    }
    if (text[i] === 0x0e || text[i] === 0x0f) shifts++;
  }
  if (hits === 0) return 0;
  let quality = Math.trunc((100 * hits - 100 * misses) / (hits + misses));
  if (hits + shifts < 5) quality -= (5 - (hits + shifts)) * 10;
  return quality < 0 ? 0 : quality;
}

/**
 * The encoding Stata names for a file's bytes. Every recognizer ICU enables
 * by default is tried, in ICU's order; the name is the last of those with
 * the highest confidence, or UTF-8 when none has any.
 */
export function detectCharset(bytes) {
  const raw = bytes.subarray(0, SAMPLE),
    input = raw.subarray(0, BUFFER);
  let c1 = false;
  for (const b of input)
    if (b >= 0x80 && b <= 0x9f) {
      c1 = true;
      break;
    }
  const languages = (name) => {
    let top = -1;
    for (const [, ngrams] of NGRAMS[name]) {
      const confidence = ngramConfidence(input, ngrams, CHAR_MAPS[name]);
      if (confidence > top) top = confidence;
    }
    return top;
  };
  const sb = (ngrams, map) =>
    ngramConfidence(input, NGRAMS[ngrams], CHAR_MAPS[map]);
  const results = [
    ["UTF-8", () => utf8(raw)],
    ["UTF-16BE", () => utf16(raw, false)],
    ["UTF-16LE", () => utf16(raw, true)],
    ["UTF-32BE", () => utf32(raw, false)],
    ["UTF-32LE", () => utf32(raw, true)],
    [c1 ? "windows-1252" : "ISO-8859-1", () => languages("8859_1")],
    [c1 ? "windows-1250" : "ISO-8859-2", () => languages("8859_2")],
    ["ISO-8859-5", () => sb("8859_5_ru", "8859_5")],
    ["ISO-8859-6", () => sb("8859_6_ar", "8859_6")],
    [c1 ? "windows-1253" : "ISO-8859-7", () => sb("8859_7_el", "8859_7")],
    [c1 ? "windows-1255" : "ISO-8859-8-I", () => sb("8859_8_I_he", "8859_8")],
    [c1 ? "windows-1255" : "ISO-8859-8", () => sb("8859_8_he", "8859_8")],
    ["windows-1251", () => sb("windows_1251", "windows_1251")],
    ["windows-1256", () => sb("windows_1256", "windows_1256")],
    ["KOI8-R", () => sb("KOI8_R", "KOI8_R")],
    [c1 ? "windows-1254" : "ISO-8859-9", () => sb("8859_9_tr", "8859_9")],
    ["Shift_JIS", () => multiByte(raw, "sjis", COMMON.sjis)],
    ["GB18030", () => multiByte(raw, "gb", COMMON.gb_18030)],
    ["EUC-JP", () => multiByte(raw, "euc", COMMON.euc_jp)],
    ["EUC-KR", () => multiByte(raw, "euc", COMMON.euc_kr)],
    ["Big5", () => multiByte(raw, "big5", COMMON.big5)],
    ["ISO-2022-JP", () => iso2022(input, ESCAPES.jp)],
    ["ISO-2022-KR", () => iso2022(input, ESCAPES.kr)],
    ["ISO-2022-CN", () => iso2022(input, ESCAPES.cn)],
  ];
  let name = "UTF-8",
    top = 0;
  for (const [candidate, confidence] of results) {
    const value = confidence();
    if (value > 0 && value >= top) {
      top = value;
      name = candidate;
    }
  }
  return name;
}
