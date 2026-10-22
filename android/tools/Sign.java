// Signs (and aligns) an APK with apksig, then checks the signature:
//   java -cp apksig.jar Sign.java <keystore.p12> <password> <in.apk> <out.apk>
import com.android.apksig.ApkSigner;
import com.android.apksig.ApkVerifier;
import java.io.File;
import java.io.FileInputStream;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.List;

public class Sign {
  public static void main(String[] args) throws Exception {
    char[] password = args[1].toCharArray();
    KeyStore store = KeyStore.getInstance("PKCS12");
    try (FileInputStream in = new FileInputStream(args[0])) {
      store.load(in, password);
    }
    String alias = store.aliases().nextElement();
    PrivateKey key = (PrivateKey) store.getKey(alias, password);
    X509Certificate cert = (X509Certificate) store.getCertificate(alias);
    ApkSigner.SignerConfig signer = new ApkSigner.SignerConfig.Builder("cardboard", key, List.of(cert)).build();
    new ApkSigner.Builder(List.of(signer))
        .setInputApk(new File(args[2]))
        .setOutputApk(new File(args[3]))
        .setMinSdkVersion(29)
        .setV1SigningEnabled(false)
        .setV2SigningEnabled(true)
        .build()
        .sign();
    ApkVerifier.Result result = new ApkVerifier.Builder(new File(args[3])).build().verify();
    if (!result.isVerified()) throw new IllegalStateException("The signed APK doesn't verify: " + result.getErrors());
    byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
    StringBuilder hex = new StringBuilder();
    for (byte b : digest) hex.append(String.format("%02X:", b));
    System.out.println("Signed. Certificate SHA-256: " + hex.substring(0, hex.length() - 1));
  }
}
