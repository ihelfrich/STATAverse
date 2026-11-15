// Pass 8, syntax group: what the Results text cannot show compactly.
// Every expected value was recorded from Stata 19 (StataMP, run in batch
// under version 17 with set processors 1); data come from runiform(), which
// the runtime draws as Stata does. The Results text itself is checked in
// tools/output-cases.txt (the syntax8- cases).
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";
import { createConsoleSession } from "../src/console-session.js";

// Recorded from Stata 19: [expression, what display printed, return code].
const NUMERIC = [
  ["sin(1)", ".841470984807897", 0],
  ["cos(1)", ".54030230586814", 0],
  ["tan(1)", "1.5574077246549", 0],
  ["asin(.5)", ".523598775598299", 0],
  ["acos(.5)", "1.0471975511966", 0],
  ["atan(2)", "1.10714871779409", 0],
  ["atan2(1,-1)", "2.35619449019234", 0],
  ["atan2(0,0)", "0", 0],
  ["sinh(1)", "1.1752011936438", 0],
  ["cosh(1)", "1.54308063481524", 0],
  ["tanh(.5)", ".46211715726001", 0],
  ["asinh(1)", ".881373587019543", 0],
  ["acosh(2)", "1.31695789692482", 0],
  ["acosh(.5)", ".", 0],
  ["atanh(.5)", ".549306144334055", 0],
  ["atanh(1)", ".", 0],
  ["atanh(-2)", ".", 0],
  ["asin(2)", ".", 0],
  ["expm1(1e-10)", "1.00000000005000e-10", 0],
  ["ln1p(1e-10)", "9.99999999950000e-11", 0],
  ["ln1p(-1)", ".", 0],
  ["ln1m(.5)", "-.693147180559945", 0],
  ["ln1m(1)", ".", 0],
  ["log1p(2)", "1.09861228866811", 0],
  ["log1m(.25)", "-.287682072451781", 0],
  ["cloglog(.5)", "-.366512920581664", 0],
  ["cloglog(0)", ".", 0],
  ["invcloglog(1)", ".934011964154687", 0],
  ["invcloglog(-800)", "0", 0],
  ["digamma(1)", "-.577215664901533", 0],
  ["digamma(.5)", "-1.96351002602102", 0],
  ["digamma(-1.5)", ".70315664064565", 0],
  ["digamma(0)", ".", 0],
  ["digamma(-2)", ".", 0],
  ["digamma(100.5)", "4.60517435258185", 0],
  ["trigamma(1)", "1.644934066848", 0],
  ["trigamma(.5)", "4.93480220052561", 0],
  ["trigamma(-1.5)", "9.37924664497006", 0],
  ["trigamma(0)", ".", 0],
  ["lnnormal(-1)", "-1.84102164500926", 0],
  ["lnnormal(-40)", "-804.608442013754", 0],
  ["lnnormal(3)", "-.00135080996474819", 0],
  ["lnnormalden(1)", "-1.41893853320467", 0],
  ["lnnormalden(1,2)", "-1.73708571376462", 0],
  ["lnnormalden(1,2,3)", "-2.07310637742834", 0],
  ["lnnormalden(1,2,-1)", ".", 0],
  ["tden(3,1)", ".206748335783172", 0],
  ["tden(0,1)", ".", 0],
  ["chi2den(3,2)", ".207553748710297", 0],
  ["chi2den(2,0)", ".5", 0],
  ["chi2den(1,0)", ".", 0],
  ["Fden(2,3,1)", ".278854800926934", 0],
  ["Fden(2,3,0)", "1", 0],
  ["Fden(1,3,0)", ".", 0],
  ["betaden(2,3,.4)", "1.728", 0],
  ["betaden(1,1,0)", "1", 0],
  ["betaden(.5,1,0)", ".", 0],
  ["betaden(2,3,1.5)", "0", 0],
  ["gammaden(2,3,0,4)", ".11715428360699", 0],
  ["gammaden(2,3,1,4)", ".122626480390481", 0],
  ["gammaden(1,3,0,0)", ".333333333333333", 0],
  ["gammaden(.5,3,0,0)", ".", 0],
  ["gammaptail(2,3)", ".199148273471456", 0],
  ["ibetatail(2,3,.4)", ".4752", 0],
  ["invgammap(2,.5)", "1.67834699001666", 0],
  ["invgammaptail(2,.5)", "1.67834699001666", 0],
  ["invibeta(2,3,.5)", ".38572756813239", 0],
  ["invibetatail(2,3,.5)", ".38572756813239", 0],
  ["binomialp(10,3,.4)", ".214990848", 0],
  ["binomial(10,3,.4)", ".3822806016", 0],
  ["binomial(10,3.5,.4)", ".3822806016", 0],
  ["binomialtail(10,3,.4)", ".8327102464", 0],
  ["binomialtail(10,3.5,.4)", ".8327102464", 0],
  ["invbinomial(10,3,.4)", ".392995123072595", 0],
  ["invbinomialtail(10,3,.4)", ".225515001343857", 0],
  ["poissonp(3,2)", ".224041807655388", 0],
  ["poisson(3,2)", ".423190081126844", 0],
  ["poissontail(3,2)", ".800851726528544", 0],
  ["invpoisson(2,.4)", "3.10537859726335", 0],
  ["invpoissontail(2,.4)", "1.37642134206289", 0],
  ["hypergeometricp(10,3,4,1)", ".5", 0],
  ["hypergeometric(10,3,4,1)", ".666666666666667", 0],
  ["binormal(.5,1,.3)", ".609308677799996", 0],
  ["binormal(.5,1,.95)", ".689139561783928", 0],
  ["binormal(.5,1,-.95)", ".532807232707709", 0],
  ["binormal(-1,-2,-.5)", ".000146859766014279", 0],
  ["binormal(.5,1,1)", ".691462461274013", 0],
  ["binormal(.5,1,-1)", ".532807207342556", 0],
  ["nchi2(3,2,4)", ".483881358388074", 0],
  ["invnchi2(3,2,.5)", "4.13751512339912", 0],
  ["npnchi2(3,4,.5)", "1.85445875129722", 0],
  ["lnigammaden(2,3,1)", "-.80277542266378", 0],
  ["igaussian(1,2,1.5)", ".824407956205137", 0],
  ["igaussiantail(1,2,1.5)", ".175592043794863", 0],
  ["igaussianden(1,2,1.5)", ".259959540963655", 0],
  ["lnigaussianden(1,2,1.5)", "-1.34722927175361", 0],
  ["exponential(2,1)", ".393469340287367", 0],
  ["exponentialden(2,1)", ".303265329856317", 0],
  ["exponentialtail(2,1)", ".606530659712633", 0],
  ["invexponential(2,.5)", "1.38629436111989", 0],
  ["invexponentialtail(2,.5)", "1.38629436111989", 0],
  ["logistic(1)", ".731058578630005", 0],
  ["logistic(2,1)", ".622459331201855", 0],
  ["logistic(1,2,3)", ".731058578630005", 0],
  ["logisticden(1)", ".196611933241482", 0],
  ["logisticden(2,1)", ".117501856100797", 0],
  ["logisticden(1,2,3)", ".0983059666207409", 0],
  ["logistictail(1)", ".268941421369995", 0],
  ["logistictail(1,2,3)", ".268941421369995", 0],
  ["invlogistic(.3)", "-.847297860387204", 0],
  ["invlogistic(2,.3)", "-1.69459572077441", 0],
  ["invlogistic(1,2,.3)", "-.694595720774407", 0],
  ["invlogistictail(.3)", ".847297860387204", 0],
  ["invlogistictail(1,2,.3)", "2.69459572077441", 0],
  ["cauchy(0,1,1)", ".75", 0],
  ["cauchytail(0,1,1)", ".25", 0],
  ["cauchyden(0,1,1)", ".159154943091895", 0],
  ["lncauchyden(0,1,1)", "-1.83787706640935", 0],
  ["invcauchy(0,1,.75)", "1", 0],
  ["invcauchytail(0,1,.75)", "-1", 0],
  ["laplace(0,1,1)", ".816060279414279", 0],
  ["laplacetail(0,1,1)", ".183939720585721", 0],
  ["laplaceden(0,1,1)", ".183939720585721", 0],
  ["lnlaplaceden(0,1,1)", "-1.69314718055995", 0],
  ["invlaplace(0,1,.75)", ".693147180559945", 0],
  ["invlaplacetail(0,1,.75)", "-.693147180559945", 0],
  ["weibull(2,3,1)", ".10516068318563", 0],
  ["weibull(2,3,.5,1)", ".0273955228836517", 0],
  ["weibulltail(2,3,1)", ".89483931681437", 0],
  ["weibullden(2,3,1)", ".198853181514304", 0],
  ["weibullden(2,3,.5,1)", ".108067164124039", 0],
  ["invweibull(2,3,.5)", "2.49766383347309", 0],
  ["invweibulltail(2,3,.5)", "2.49766383347309", 0],
  ["weibullph(2,3,1)", ".950212931632136", 0],
  ["weibullphtail(2,3,1)", ".0497870683678639", 0],
  ["weibullphden(2,3,1)", ".298722410207184", 0],
  ["invweibullph(2,3,.5)", ".480675628866961", 0],
  ["invweibullphtail(2,3,.5)", ".480675628866961", 0],
  ["nbinomialp(2,3,.4)", ".13824", 0],
  ["nbinomial(2,3,.4)", ".66304", 0],
  ["nbinomialtail(2,3,.4)", ".4752", 0],
  ["exponential(2,-1)", ".", 0],
  ["laplace(0,1,-1)", ".183939720585721", 0],
  ["logistic(1,-2,3)", ".", 0],
  ["poissontail(3,2.5)", ".800851726528544", 0],
  ["poisson(3,2.5)", ".423190081126844", 0],
  ["poissonp(3,2.5)", ".224041807655388", 0],
  ["nbinomialtail(2,3.5,.4)", ".4752", 0],
  ["nbinomial(2,3.5,.4)", ".66304", 0],
  ["nbinomialp(2,3.5,.4)", ".13824", 0],
  ["binomialp(10,3.5,.4)", ".214990848", 0],
  ["binomial(10,-1,.4)", "0", 0],
  ["binomialtail(10,-1,.4)", "1", 0],
  ["binomialtail(10,11,.4)", "0", 0],
  ["hypergeometric(10,3,4,1.5)", ".666666666666667", 0],
  ["invbinomial(10,3.5,.4)", ".392995123072595", 0],
  ["invbinomialtail(10,3.5,.4)", ".225515001343857", 0],
  ["invpoisson(2.5,.4)", "3.10537859726335", 0],
  ["invpoissontail(2.5,.4)", "1.37642134206289", 0],
  ["invpoisson(0,.4)", ".916290731874154", 0],
  ["invpoissontail(0,.4)", ".", 0],
  ["binomial(10.5,3,.4)", ".3822806016", 0],
  ["poisson(0,2)", ".", 0],
  ["poissontail(3,0)", "1", 0],
  ["nbinomial(2.5,3,.4)", ".555801921551194", 0],
  ["nbinomialtail(2,0,.4)", "1", 0],
  ["gammap(2,0)", "0", 0],
  ["invgammap(2,0)", "0", 0],
  ["invgammap(2,1)", ".", 0],
  ["invibeta(2,3,0)", "0", 0],
  ["invibeta(2,3,1)", "1", 0],
  ["invnchi2(3,0,.5)", "2.36597388437535", 0],
  ["npnchi2(3,4,.9)", ".", 0],
  ["binormal(0,0,0)", ".25", 0],
  ["binormal(10,10,.5)", "1", 0],
  ["binormal(-10,-10,.5)", "0", 0],
  ["tden(3.5,-2)", ".0669179050686308", 0],
  ["Fden(2.5,3.5,1.5)", ".196298389529771", 0],
  ["digamma(1e-8)", "-100000000.577216", 0],
  ["trigamma(1e10)", "1.00000000005000e-10", 0],
  ["lnnormal(-38)", "-726.55721601882", 0],
  ["lnnormal(-5)", "-15.0649983939887", 0],
  ["lnnormal(-21)", "-224.465715831414", 0],
  ["hypergeometricp(10,3,4,0)", ".166666666666667", 0],
  ["weibull(2,3,.5,0.2)", "0", 0],
  ["invweibull(2,3,.5,1)", ".", 0],
  ["nbinomialp(2,0,1)", "1", 0],
  ["igaussian(1,2,0)", "0", 0],
  ["igaussian(1,2,30)", ".999999999999998", 0],
  ["igaussiantail(1,2,30)", "2.10942374678780e-15", 0],
  ["cloglog(1)", ".", 0],
  ["lnigammaden(2,3,0)", ".", 0],
  ["recode(3,1,2,4)", "4", 0],
  ["recode(5,1,2,4)", "4", 0],
  ["recode(1,1,2,4)", "1", 0],
  ["recode(.,1,2,4)", ".", 0],
  ["recode(3,1)", "invalid syntax", 198],
  ["irecode(3,1,2,4)", "2", 0],
  ["irecode(0,1,2,4)", "0", 0],
  ["irecode(9,1,2,4)", "3", 0],
  ["irecode(.,1,2,4)", ".", 0],
  ["irecode(2,1,2,4)", "1", 0],
  ["autocode(3,4,0,10)", "5", 0],
  ["autocode(0,4,0,10)", "2.5", 0],
  ["autocode(10,4,0,10)", "10", 0],
  ["autocode(12,4,0,10)", "10", 0],
  ["autocode(-3,4,0,10)", "2.5", 0],
  ["autocode(2.5,4,0,10)", "2.5", 0],
  ["autocode(.,4,0,10)", ".", 0],
  ["chop(1.0000000001,1e-6)", "1", 0],
  ["chop(1.1,1e-6)", "1.1", 0],
  ["chop(-2.0000001,1e-3)", "-2", 0],
  ["epsdouble()", "2.22044604925031e-16", 0],
  ["epsfloat()", "1.19209289550781e-07", 0],
  ["smallestdouble()", "2.2250738585072e-308", 0],
  ["maxbyte()", "100", 0],
  ["minbyte()", "-127", 0],
  ["maxint()", "32740", 0],
  ["minint()", "-32767", 0],
  ["maxlong()", "2147483620", 0],
  ["minlong()", "-2147483647", 0],
  ["maxfloat()", "1.70141173319264e+38", 0],
  ["minfloat()", "-1.70141173319264e+38", 0],
  ["maxdouble()", "8.9884656743116e+307", 0],
  ['fmtwidth("%9.2f")', "9", 0],
  ['fmtwidth("%-12s")', "12", 0],
  ['fmtwidth("%td")', "9", 0],
  ['fmtwidth("%tc")', "18", 0],
  ['fmtwidth("%9.0gc")', "9", 0],
  ['fmtwidth("bad")', ".", 0],
  ['fmtwidth("%tdDD/NN/CCYY")', "10", 0],
  ['fmtwidth("%tq")', "6", 0],
  ["byteorder()", "2", 0],
  ["nF(2,3,1,1)", ".411954536827997", 0],
  ["nFden(2,3,1,1)", ".270087389457697", 0],
  ["nFtail(2,3,1,1)", ".588045463172003", 0],
  ["invnFtail(2,3,1,.5)", "1.37116387507527", 0],
  ["npnF(2,3,1,.5)", ".261114130812185", 0],
  ["nbetaden(1,2,1,.5)", "1.1925386990778", 0],
  ["nibeta(1,2,1,.5)", ".632775636245516", 0],
  ["invnibeta(1,2,1,.5)", ".392340733536615", 0],
  ["nibeta(2.5,3,10,.6)", ".237755028831616", 0],
  ["nF(4,20,30,3)", ".0187447804777881", 0],
  ["nt(3,1,1)", ".469226872418325", 0],
  ["ntden(3,1,1)", ".341181668182346", 0],
  ["nttail(3,1,1)", ".530773127581675", 0],
  ["invnttail(3,1,.5)", "1.0911525465804", 0],
  ["npnt(3,1,.5)", ".917144581650833", 0],
  ["nt(10,2,-1)", ".0018164334104297", 0],
  ["nt(10,-2,1)", ".99818356658957", 0],
  ["nt(5,0,1.5)", ".903048159878763", 0],
  ["nt(20,5,6)", ".748069502430772", 0],
  ["ntden(10,2,0)", ".0526600933537835", 0],
  ["ntden(10,2,-1)", ".00480902412055335", 0],
  ["invnttail(10,2,.05)", "4.3574751786644", 0],
  ["npnt(10,2,.9)", ".551740003692207", 0],
  ["invigaussian(1,1,.5)", ".675841305695239", 0],
  ["invigaussiantail(1,1,.5)", ".675841305695239", 0],
  ["invigaussian(2,3,.9)", "3.98473879577609", 0],
  ["invnbinomial(2,1,.5)", ".499999999999999", 0],
  ["invnbinomialtail(2,1,.5)", ".707106781186547", 0],
  ["invnbinomial(3.5,4,.2)", ".267417691821583", 0],
  ["invnbinomialtail(3.5,4,.2)", ".62044252317889", 0],
];
const STRINGS = [
  ['ustrregexm("abc","b")', "1", 0],
  ['ustrregexm("abc","B")', "0", 0],
  ['ustrregexm("abc","B",1)', "1", 0],
  ['ustrregexm("abc","(")', "-1", 0],
  ['ustrregexra("abc","b","x")', "axc", 0],
  ['ustrregexra("banana","a","o")', "bonono", 0],
  ['ustrregexra("banana","(an)","<$1>")', "b<an><an>a", 0],
  ['ustrregexrf("banana","a","o")', "bonana", 0],
  ['ustrregexra("abc","","-")', "-a-b-c-", 0],
  ['ustrregexra("a.b","\\.","!")', "a!b", 0],
  ['ustrregexra("Hello World","[[:upper:]]","_")', "_ello _orld", 0],
  ['ustrregexra("abc","(?i)B","x")', "axc", 0],
  ['ustrregexra("a1b22","\\d+","#")', "a#b#", 0],
  ['ustrregexra("x","x","\\$")', "", 0],
  ['ustrregexra("abc","b","$2")', "", 0],
  ['ustrregexm("café","é") + ustrregexm("Straße","ß")', "2", 0],
  ['ustrregexm("2024-01-05","(\\d+)-(\\d+)-(\\d+)") + 0', "1", 0],
  ['ustrtrim("  ab  ")', "ab", 0],
  ['ustrltrim("  ab  ")', "ab  ", 0],
  ['ustrrtrim("  ab  ")', "  ab", 0],
  ['ustrtitle("ab cd")', "Ab Cd", 0],
  ['ustrtitle("hello WORLD o\'neil")', "Hello World O'neil", 0],
  ['ustrtitle("élan vital")', "Élan Vital", 0],
  ['ustrleft("abcdef",2)', "ab", 0],
  ['ustrleft("abcdef",-1)', "", 0],
  ['ustrleft("abcdef",.)', "abcdef", 0],
  ['ustrright("abcdef",2)', "ef", 0],
  ['ustrright("abcdef",0)', "", 0],
  ['ustrword("ab cd ef",2)', "cd", 0],
  ['ustrword("ab cd ef",-1)', "ef", 0],
  ['ustrword("ab, cd. ef",2)', ",", 0],
  ['ustrword("ab cd ef",0)', "", 0],
  ['ustrword("ab cd ef",9)', "", 0],
  ['ustrwordcount("ab cd ef")', "3", 0],
  ['ustrwordcount("ab, cd. ef")', "5", 0],
  ['ustrwordcount("")', "0", 0],
  ['ustrcompare("a","b")', "-1", 0],
  ['ustrcompare("b","a")', "1", 0],
  ['ustrcompare("a","a")', "0", 0],
  ['ustrcompare("a","B")', "1", 0],
  ['ustrcompare("Z","a")', "-1", 0],
  ['ustrnormalize("a","nfc")', "a", 0],
  ['ustrnormalize("é","nfd") == "é"', "0", 0],
  ['ustrlen(ustrnormalize("é","nfd"))', "2", 0],
  ['ustrnormalize("a","bad")', "", 0],
  ['ustrtohex("a")', "\\u0061", 0],
  ['ustrtohex("aé")', "\\u0061\\u00e9", 0],
  ['ustrtohex("abc",2)', "\\u0062\\u0063", 0],
  ['ustrunescape("é")', "Ã©", 0],
  ['ustrunescape("a\\nb")', "a\nb", 0],
  ["uchar(65)", "A", 0],
  ["uchar(233)", "é", 0],
  ["uchar(-1)", "", 0],
  ['uisdigit("1a")', "1", 0],
  ['uisdigit("a1")', "0", 0],
  ['uisletter("é")', "1", 0],
  ['uisletter("1")', "0", 0],
  ['ustrrpos("abcabc","b")', "5", 0],
  ['ustrrpos("abcabc","b",4)', "2", 0],
  ['ustrrpos("abcabc","")', "0", 0],
  ['ustrpos("abcabc","b")', "2", 0],
  ['ustrpos("abcabc","b",3)', "5", 0],
  ['ustrpos("abcabc","b",9)', "0", 0],
  ['ustrpos("abcabc","")', "0", 0],
  ['ustrpos("éabc","b")', "3", 0],
  ['ustrlen("éab")', "3", 0],
  ['usubstr("éabc",2,2)', "ab", 0],
  ['usubstr("éabc",-2,2)', "bc", 0],
  ['ustrupper("éa")', "ÉA", 0],
  ['ustrlower("ÉA")', "éa", 0],
  ['ustrreverse("éab")', "baé", 0],
  ['ustrinvalidcnt("ab")', "0", 0],
  ['soundex("Robert")', "R163", 0],
  ['soundex("Rupert")', "R163", 0],
  ['soundex("Ashcraft")', "A226", 0],
  ['soundex("Tymczak")', "T522", 0],
  ['soundex("Pfister")', "P236", 0],
  ['soundex("Honeyman")', "H555", 0],
  ['soundex_nara("Ashcraft")', "A261", 0],
  ['soundex_nara("Tymczak")', "T522", 0],
  ['soundex("")', "", 0],
  ['tobytes("a")', "\\d097", 0],
  ['tobytes("é")', "\\d195\\d169", 0],
  ['tobytes("a",1)', "\\x61", 0],
  ['plural(1,"car")', "car", 0],
  ['plural(2,"car")', "cars", 0],
  ['plural(2,"box","+es")', "boxes", 0],
  ['plural(2,"bus","-s")', "bu", 0],
  ['plural(2,"mouse","mice")', "mice", 0],
  ['plural(0,"car")', "cars", 0],
  ['indexnot("abc","ab")', "3", 0],
  ['indexnot("abc","abc")', "0", 0],
  ['regexmatch("abc","b")', "1", 0],
  ['regexreplace("banana","a","o")', "bonana", 0],
  ['regexreplaceall("banana","a","o")', "bonono", 0],
  ['bsubstr("abc",2,1)', "b", 0],
];

const close = (actual, expected, tolerance) =>
  Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected));

// Stata's own digamma and trigamma are good to about 1e-12 (trigamma(.5)
// is 4.93480220052561 there, pi^2/2 = 4.934802200544679 here); every
// other function agrees to 1e-12 of its value.
test("the math and distribution functions give Stata's values", () => {
  const failures = [];
  for (const [expression, expected, code] of NUMERIC) {
    const session = new Session(),
      result = session.run(`display %21.15g ${expression}`),
      shown = result.output.flatMap((o) => o.lines)[0]?.trim() ?? "";
    if (code) {
      if (result.rc !== code) failures.push(`${expression}: rc ${result.rc}`);
      continue;
    }
    if (result.rc) {
      failures.push(`${expression}: rc ${result.rc} ${shown}`);
      continue;
    }
    const ok =
      expected === "."
        ? shown === "."
        : close(
            Number(shown),
            Number(expected),
            /gamma\(/.test(expression) ? 1e-11 : 1e-12,
          );
    if (!ok) failures.push(`${expression}: ${shown}, Stata ${expected}`);
  }
  assert.deepEqual(failures, []);
});

test("the Unicode string and regular-expression functions give Stata's results", () => {
  const failures = [];
  for (const [expression, expected, code] of STRINGS) {
    const session = new Session(),
      result = session.run(`display "[" ${expression} "]"`),
      shown = result.output
        .flatMap((o) => o.lines)
        .join("\n")
        .replace(/^\[|\]$/g, "");
    if (result.rc !== code || (!code && shown !== expected))
      failures.push(
        `${expression}: ${shown} (rc ${result.rc}), Stata ${expected}`,
      );
  }
  assert.deepEqual(failures, []);
});

test("closed-form random draws follow Stata's uniform stream", () => {
  // Stata 19, set seed 1, six observations: the first three draws.
  const expected = {
    "rlogistic(1,2)": [
      -2.7342170658474161, -2.690916441103465, 0.60847362463374743,
    ],
    "rcauchy(1,2)": [
      -3.4715174738886718, -3.3778094223732955, 0.69105138618261919,
    ],
    "rlaplace(1,2)": [
      -1.6353785790480417, -1.5979295361618249, 0.79467126557293777,
    ],
    "rweibull(2,3,1)": [
      5.2541189723320727, 5.2342658794373929, 3.676248106951463,
    ],
    "rweibullph(2,3)": [
      0.81870557794687215, 0.81488484843787545, 0.51504418832221777,
    ],
    "runiform()": [
      0.13387664401253263, 0.13640703636619722, 0.45121490384453822,
    ],
  };
  for (const [call, values] of Object.entries(expected)) {
    const session = new Session();
    session.run(`clear\nset obs 6\nset seed 1\ngenerate double v = ${call}`);
    const drawn = Array.from(session.data.get("v").data).slice(0, 3);
    drawn.forEach((v, k) =>
      assert.ok(close(v, values[k], 1e-15), `${call}: ${v} vs ${values[k]}`),
    );
  }
});

test("runiform() gives Stata's doubles to the last bit", () => {
  // set seed 1, 42, 1000 and 2147483647, then runiform(), at %21.17g.
  for (const [seed, value] of [
    [1, ".13387664401253263"],
    [42, ".75515553295453908"],
    [1000, ".14270650073753333"],
    [2147483647, ".16803268731662413"],
  ]) {
    const session = new Session(),
      result = session.run(`set seed ${seed}\ndisplay %21.17g runiform()`);
    assert.equal(result.output.at(-1).lines[0].trim(), value);
  }
});

test("functions Stata has and the browser lacks are refused as not available", () => {
  for (const name of [
    "rgamma(2,1)",
    "rchi2(3)",
    "rbeta(1,2)",
    'ustrsortkey("a")',
    "tukeyprob(3,10,2)",
  ]) {
    const result = new Session().run(`display ${name}`);
    assert.equal(result.rc, 198, name);
    assert.match(
      result.output[0].lines[0],
      /is a Stata function that is not available in the browser yet/,
    );
  }
  const unknown = new Session().run("display nosuchfn(1)");
  assert.equal(unknown.rc, 133);
  assert.equal(unknown.output[0].lines[0], "unknown function nosuchfn()");
});

// ----- blocks, comments and programs (G75) -----
const lines = (source, options = { doFile: true }) => {
  const console = createConsoleSession(),
    result = console.run(source, options);
  return {
    rc: result.rc,
    text: result.output.flatMap((o) => [
      `. ${o.command}`,
      ...(o.echo ?? []),
      ...o.lines,
    ]),
  };
};

test("a stray } runs the lines before it and stops there", () => {
  const { rc, text } = lines("clear\nset obs 3\ndi 1\n}\ndi 2\n");
  assert.equal(rc, 199);
  assert.deepEqual(text.slice(-4), [
    "1",
    ". }",
    "} is not a valid command name",
    "r(199);",
  ]);
  assert.ok(text.includes("Number of observations (_N) was 0, now 3."));
  assert.ok(text.includes("} is not a valid command name"));
  assert.ok(!text.includes("2"));
});

test("a loop the file never closes stops with r(612) after the lines before it", () => {
  const { rc, text } = lines(
    "clear\nset obs 3\ndi 1\nforvalues i=1/3 {\ndi `i'\n",
  );
  assert.equal(rc, 612);
  assert.deepEqual(text.slice(-6), [
    "1",
    ". forvalues i=1/3 {",
    "  2. di `i'",
    "  3. ",
    "unexpected end of file",
    "r(612);",
  ]);
});

test("a program or input without end stops with r(612)", () => {
  const program = lines("clear\nset obs 3\ndi 1\nprogram pp\ndi 5\n");
  assert.equal(program.rc, 612);
  assert.deepEqual(program.text.slice(-5), [
    ". program pp",
    "  1. di 5",
    "  2. ",
    "unexpected end of file",
    "r(612);",
  ]);
  const input = lines("clear\ninput v\n1\n2\n");
  assert.equal(input.rc, 612);
  assert.deepEqual(input.text.slice(-6), [
    "             v",
    "  1. 1",
    "  2. 2",
    "  3.",
    "unexpected end of file",
    "r(612);",
  ]);
});

test("input fills observations that have no variables yet", () => {
  const session = new Session();
  session.run("clear\nset obs 3\ninput v\n1\n2\nend\n");
  assert.equal(session.data.n, 3);
  assert.deepEqual(Array.from(session.data.get("v").data).slice(0, 2), [1, 2]);
});

test("an unclosed /* comments out the rest of the file without an error", () => {
  const { rc, text } = lines("clear\nset obs 3\ndi 1\n/* di 2\ndi 3\n");
  assert.equal(rc, 0);
  assert.ok(!text.includes("2") && !text.includes("3"));
  const midline = lines("di 1\ndi 2 /* tail\ndi 3\n");
  assert.equal(midline.rc, 0);
  // Stata 19 echoes the lines it reads, the comment's with them.
  assert.deepEqual(midline.text, [". di 1", "1", ". di 2 /* tail", "> di 3"]);
});

test("other blocks the file never closes run, then stop with r(198)", () => {
  // Stata 19: the body runs and the error follows.
  const cases = [
    ["di 1\nif 1 {\ndi 2\n", ["1", "2"]],
    ["di 1\nif 0 {\ndi 2\n", ["1"]],
    ["di 1\nquietly {\ndi 2\nnoi di 3\n", ["1", "3"]],
    ["di 1\n{\ndi 2\n", ["1", "2"]],
    [
      "program pp\nforvalues i=1/3 {\ndi `i'\ndi \"x`i'\"\nend\npp\ndi 3\n",
      ["1", "x1"],
    ],
    ['program pp\nif 1 {\ndi "a"\ndi "b"\nend\npp\ndi 3\n', ["a", "b"]],
  ];
  for (const [source, shown] of cases) {
    const session = new Session(),
      result = session.run(source),
      printed = result.output.flatMap((o) => o.lines);
    assert.equal(result.rc, 198, source);
    assert.deepEqual(
      printed.filter((line) => !/^r\(|error/.test(line)),
      shown,
      source,
    );
    assert.ok(
      printed.includes("program error:  matching close brace not found"),
      source,
    );
  }
});

test("a block of its own, { ... }, runs its commands", () => {
  const result = new Session().run(
    "di 1\n{\ndi 2\n}\ndi 3\n{\n  di 5\n  {\n    di 6\n  }\n}\n",
  );
  assert.equal(result.rc, 0);
  assert.deepEqual(
    result.output.flatMap((o) => o.lines),
    ["1", "2", "3", "5", "6"],
  );
});

test("code on the line of a brace is Stata's program error", () => {
  const open = new Session().run("forvalues i = 1/3 { di `i' }");
  assert.equal(open.rc, 198);
  assert.equal(
    open.output[0].lines[0],
    "program error:  code follows on the same line as open brace",
  );
  const quiet = new Session().run("quietly { di 1 }");
  assert.equal(quiet.rc, 198);
  assert.equal(
    quiet.output[0].lines[0],
    "program error:  code follows on the same line as open brace",
  );
  const iff = new Session().run("if 1 { di 1 }");
  assert.equal(iff.rc, 198);
  assert.equal(
    iff.output[0].lines[0],
    "program error:  matching close brace not found",
  );
  // A } with more after it: the loop runs once, then stops.
  for (const source of [
    "forvalues i=1/2 {\ndi `i'\n} di 3\n",
    "forvalues i = 1/2 {\ndi `i'\n}}\n",
    "while 1 {\ndi 1\n} di 2\n",
  ]) {
    const result = new Session().run(source),
      printed = result.output.flatMap((o) => o.lines);
    assert.equal(result.rc, 198, source);
    assert.deepEqual(printed.slice(0, 2), [
      "1",
      "program error:  code follows on the same line as close brace",
    ]);
  }
});

// ----- loops (G80, G82) -----
const failure = (source) => {
  const result = new Session().run(source),
    last = result.output.at(-1);
  return [last.lines.filter((l) => !/^r\(/.test(l)).join("\n"), result.rc];
};

test("forvalues and foreach near-misses give Stata's messages", () => {
  for (const [source, expected] of [
    ["forvalues i 1/3 {\ndi `i'\n}", ["invalid syntax", 198]],
    ["forvalues i = 1(1) {\ndi 1\n}", ["invalid syntax", 198]],
    ["forvalues i = 1/3 5 {\ndi 1\n}", ["invalid syntax", 198]],
    ["forvalues i = 1 2 3 {\ndi 1\n}", ["invalid syntax", 198]],
    ["forvalues i = a/b {\ndi 1\n}", ["invalid syntax", 198]],
    ["forvalues i = 1/3, {\ndi 1\n}", ["invalid syntax", 198]],
    [
      "forvalues i=1(0)3 {\ndi 1\n}",
      ["forvalues:  increment may not be zero", 198],
    ],
    ["forvalues = 1/3 {\ndi 1\n}", ["_= invalid name", 198]],
    ["forvalues i = 1/3\ndi 1", ["{ required", 100]],
    ["foreach v of x y {\ndi 1\n}", ["invalid syntax", 198]],
    ["foreach of local x {\ndi 1\n}", ["invalid syntax", 198]],
    ["foreach w of local {\ndi 1\n}", ["_{ invalid name", 198]],
    ["global g a b\nforeach w of global g h {\ndi 1\n}", ["{ required", 100]],
  ])
    assert.deepEqual(failure(source), expected, source);
});

test("forvalues takes Stata's four forms of range", () => {
  for (const [range, values] of [
    ["1 3 to 7", ["1", "3", "5", "7"]],
    ["1 3 : 7", ["1", "3", "5", "7"]],
    ["1.5/3", ["1.5", "2.5"]],
    ["3/1", []],
    ["1(2)6", ["1", "3", "5"]],
    ["10(-3)1", ["10", "7", "4", "1"]],
  ]) {
    const result = new Session().run(`forvalues i = ${range} {\ndi \`i'\n}`);
    assert.equal(result.rc, 0, range);
    assert.deepEqual(
      result.output.flatMap((o) => o.lines),
      values,
      range,
    );
  }
  // A name that starts with a digit is a local name Stata accepts.
  assert.equal(new Session().run("forvalues 1i = 1/2 {\ndi 1\n}").rc, 0);
});

test("foreach of local with the macro dereferenced stops as Stata does", () => {
  const result = new Session().run(
    'local list a b c\nforeach w of local `list\' {\ndi "`w\'"\n}\ndi "done"',
  );
  assert.equal(result.rc, 100);
  assert.equal(result.output.at(-1).lines[0], "{ required");
  assert.ok(!result.output.flatMap((o) => o.lines).includes("done"));
});

test("numlists take commas between elements", () => {
  const loop = new Session().run("foreach i of numlist 1,2 4 {\ndi `i'\n}");
  assert.deepEqual(
    loop.output.flatMap((o) => o.lines),
    ["1", "2", "4"],
  );
  assert.equal(
    new Session().run("foreach i of numlist 1,,2 {\ndi 1\n}").rc,
    121,
  );
  const session = new Session();
  session.run('numlist "1/3,5"');
  assert.equal(session.results.r.numlist, "1 2 3 5");
});

// ----- by (G72, G81) -----
test("by without its colon is : required", () => {
  for (const source of ["by g sum x", "by g, sort sum x", "bysort g sum x"]) {
    const result = new Session().run(
      `clear\nset obs 4\ngen g = ceil(_n/2)\ngen x = _n\n${source}`,
    );
    assert.equal(result.rc, 100, source);
    assert.equal(result.output.at(-1).lines[0], ": required");
  }
});

test("by takes sort and rc0 in either order", () => {
  const result = new Session().run(
    "clear\nset obs 6\ngen g = ceil(_n/2)\ngen x = cond(g==2, 5, mod(_n,2))\nby g, rc0 sort: prtest x == .5\ndi _rc\nby g, sort rc0: count",
  );
  assert.equal(result.rc, 0);
  const text = result.output.flatMap((o) => o.lines);
  assert.ok(text.includes("x is not a 0/1 variable"));
  assert.ok(text.includes("(return code was 450)"));
});

// ----- ivreg (G47, G86) -----
test("ivreg fits two-stage least squares as Stata 19's ivreg reports it", () => {
  const session = new Session();
  session.run(`clear
set seed 12345
set obs 200
gen z = runiform()
gen w = runiform()
gen u = runiform()-.5
gen x = .8*z + .5*u + runiform()
gen y = 1 + 2*x + .5*w + u
quietly ivreg y w (x = z)`);
  const e = session.results.e;
  assert.equal(e.cmd, "ivreg");
  assert.ok(close(e.F, 285.1638187968956, 1e-10));
  assert.ok(close(e.r2, 0.9029831751235784, 1e-12));
  assert.ok(close(e.rmse, 0.3092274474791566, 1e-12));
  assert.ok(close(e.mss, 175.3294613451258, 1e-12));
  assert.ok(close(e.rss, 18.83745801207149, 1e-12));
  assert.equal(e.instd, "x");
  assert.equal(e.insts, "w z");
  // Typed alone it shows the fit again; Stata's ivreg takes no vce().
  const replay = session.run("ivreg");
  assert.equal(replay.rc, 0);
  assert.match(
    replay.output[0].lines.join("\n"),
    /Instrumental variables 2SLS regression/,
  );
  const vce = session.run("ivreg y w (x = z), vce(robust)");
  assert.equal(vce.rc, 198);
  assert.equal(vce.output[0].lines[0], "option vce() not allowed");
  const nocons = session.run("ivreg y w (x = z), noconstant");
  assert.equal(nocons.rc, 198);
  assert.match(nocons.output[0].lines[0], /not available in the browser/);
});

// ----- commands Stata has that the browser does not run (G71) -----
test("a real Stata command the browser lacks is not called unrecognized", () => {
  for (const name of [
    "etable",
    "sureg (y x) (x y)",
    "xtgee y x",
    "rreg y x",
    "sem (y <- x)",
    "ladder y",
    "lpoly y x",
    "statsby _b, by(g): regress y x",
    "stepwise, pr(.2): regress y x",
  ]) {
    const result = new Session().run(name),
      word = name.split(/[\s,]/)[0];
    assert.equal(result.rc, 199, name);
    assert.equal(
      result.output[0].lines[0],
      `${word} is a Stata command that the browser does not run yet`,
    );
  }
  assert.equal(
    new Session().run("fakecmdzz").output[0].lines[0],
    "command fakecmdzz is unrecognized",
  );
});

// ----- smaller syntax (G59, G90, G94) -----
test("a compound-quoted string holding quotes and brackets displays whole", () => {
  for (const [source, shown] of [
    ['display `"a "b (c"\' "d)"', 'a "b (cd)'],
    ['display `"x "y (z"\' 3', 'x "y (z3'],
    ['display `"(("\' "))"', "(())"],
  ]) {
    const result = new Session().run(source);
    assert.equal(result.rc, 0, source);
    assert.equal(result.output[0].lines[0], shown);
  }
});

test("blanks inside parentheses join names and numbers, as Stata reads them", () => {
  const session = new Session();
  session.run(
    "clear\nset obs 3\ngen x = _n\ngen x12 = 100\ngen y = 2\ngen xy = 7",
  );
  for (const [expression, value] of [
    ["(1 2)", "12"],
    ["(1 .5)", "1.5"],
    ['("a" "b")', "a"],
    ["(x 1 2)", "100"],
    ["max(x y, 3)", "7"],
  ])
    assert.equal(
      session.run(`display ${expression}`).output[0].lines[0],
      value,
    );
  for (const [source, message, code] of [
    ["gen a = x y", "invalid 'y'", 198],
    ["gen a = 1 + 2 3", "invalid '3'", 198],
    ["gen a = (1) (2)", "invalid '('", 198],
    ["count if x 1", "invalid '1'", 198],
    ["gen a = (x + y z)", "yz not found", 111],
  ]) {
    const result = session.run(source);
    assert.equal(result.rc, code, source);
    assert.equal(result.output[0].lines[0].trim(), message, source);
  }
});

test("else with no if runs, and a line ending in { is otherwise a command", () => {
  const twice = new Session().run(
    "else {\ndi 1\n}\nelse {\ndi 2\n}\nelse di 3",
  );
  assert.equal(twice.rc, 0);
  assert.deepEqual(
    twice.output.flatMap((o) => o.lines),
    ["1", "2", "3"],
  );
  const taken = new Session().run("if 1 di 1\nelse di 2\nelse di 3");
  assert.deepEqual(
    taken.output.flatMap((o) => o.lines),
    ["1"],
  );
  for (const [source, message, code] of [
    ["xyz {\ndi 1\n}", "command xyz is unrecognized", 199],
    ["while {\ndi 1\n}", "invalid syntax", 198],
  ]) {
    const result = new Session().run(source);
    assert.equal(result.rc, code, source);
    assert.ok(result.output.at(-1).lines.includes(message), source);
  }
  assert.equal(new Session().run('display "a" {').rc, 198);
});

// ----- the second round on the syntax group's fixes -----
// What the Console shows, compared with Stata 19's log of the same
// do-file, blank lines aside.
const transcript = (source) => {
  const { rc, text } = lines(source);
  return { rc, text: text.filter((line) => line !== "") };
};

test("forvalues adds its step as Stata does and stops past the end", () => {
  const printed = (source) =>
    new Session()
      .run(source)
      .output.flatMap((o) => o.lines)
      .join(" ");
  // Stata 19: 1.2 + .1 is a hair over 1.3, so the loop stops at 1.2.
  for (const [range, shown] of [
    ["1(0.1)1.3", "1 1.1 1.2"],
    [
      "0(.1)1",
      "0 .1 .2 .3 .4 .5 .6 .7 .7999999999999999 .8999999999999999 .9999999999999999",
    ],
    ["1 1.1 to 1.3", "1 1.1 1.2"],
    ["1 1.1 : 1.3", "1 1.1 1.2"],
    ["3(-.1)2.7", "3 2.9 2.8"],
    ["0(.01).1", "0 .01 .02 .03 .04 .05 .06 .07 .08 .09 .1"],
    ["0(.3)2.1", "0 .3 .6 .8999999999999999 1.2 1.5 1.8 2.1"],
    [
      "0(-.1)-1",
      "0 -.1 -.2 -.3 -.4 -.5 -.6 -.7 -.7999999999999999 -.8999999999999999 -.9999999999999999",
    ],
    [
      "-1(.1)0",
      "-1 -.9 -.8 -.7000000000000001 -.6000000000000001 -.5000000000000001 -.4000000000000001 -.3000000000000002 -.2000000000000001 -.1000000000000001 -1.38777878078e-16",
    ],
    [
      "0(.07).8",
      "0 .07 .14 .21 .28 .35 .42 .49 .5600000000000001 .6300000000000001 .7000000000000002 .7700000000000002",
    ],
    ["10(.1)11", "10 10.1 10.2 10.3 10.4 10.5 10.6 10.7 10.8 10.9 11"],
  ])
    assert.equal(
      printed(`forvalues i = ${range} {\ndisplay "\`i'"\n}`),
      shown,
      range,
    );
  assert.equal(
    printed(
      "local n 0\nforvalues i = 0(.001)5 {\nlocal n = `n' + 1\nlocal last `i'\n}\ndisplay `n' \" `last'\"",
    ),
    "5000 4.999000000000004",
  );
});

test("a command ending in { opens no block in a do-file", () => {
  const brace = transcript('local brace {\ndi "`brace\'"\ndi "after"\n');
  assert.equal(brace.rc, 0);
  assert.deepEqual(brace.text, [
    ". local brace {",
    '. di "`brace\'"',
    "{",
    '. di "after"',
    "after",
  ]);
  const more = transcript(
    'global g a {\ndi "$g"\nlocal q {\nlocal r }\ndi "`q\'`r\'"\ndi "after"\n',
  );
  assert.equal(more.rc, 0);
  assert.deepEqual(more.text, [
    ". global g a {",
    '. di "$g"',
    "a {",
    ". local q {",
    ". local r }",
    ". di \"`q'`r'\"",
    "{}",
    '. di "after"',
    "after",
  ]);
  // Stata 19 names only the first brace of }}.
  const stray = transcript("di 1\n}}\ndi 2\n");
  assert.equal(stray.rc, 199);
  assert.deepEqual(stray.text.slice(-3), [
    ". }}",
    "} is not a valid command name",
    "r(199);",
  ]);
});

test("a program defined twice stops with Stata's message", () => {
  const twice = transcript(
    'program pp\n  di "pp"\nend\nprogram pp\n  di "again"\nend\ndi 2\n',
  );
  assert.equal(twice.rc, 110);
  assert.deepEqual(twice.text, [
    ". program pp",
    '  1.   di "pp"',
    "  2. end",
    ". program pp",
    "program pp already defined",
    "r(110);",
  ]);
});

test("if, else and noisily blocks echo as Stata reads them", () => {
  const chain = transcript(
    'if 0 di "e"\nelse di "x"\nelse di "y"\nif 0 {\n di "k"\n}\nelse di "m"\nelse di "n"\nelse {\n di "o"\n}\ndi "end"\n',
  );
  assert.equal(chain.rc, 0);
  assert.deepEqual(chain.text, [
    '. if 0 di "e"',
    '. else di "x"',
    "x",
    '. else di "y"',
    "y",
    ". if 0 {",
    '.  di "k"',
    ". }",
    '. else di "m"',
    "m",
    '. else di "n"',
    "n",
    ". else {",
    '.  di "o"',
    "o",
    ". }",
    '. di "end"',
    "end",
  ]);
  // After a true if, no later else runs.
  assert.deepEqual(
    new Session()
      .run("if 1 di 1\nelse di 2\nelse di 3")
      .output.flatMap((o) => o.lines),
    ["1"],
  );
  const captured = transcript(
    "capture noisily {\n  di 4\n  error 459\n  di 5\n  if 1 {\n    di 6\n  }\n}\ndi _rc\ncap noi {\n  di 7\n}\ndi _rc\nnoisily {\n  di 8\n}\ncapture noisily {\n  if 1 {\n    error 198\n  }\n  di 9\n}\ndi _rc\n",
  );
  assert.equal(captured.rc, 0);
  assert.deepEqual(captured.text, [
    ". capture noisily {",
    ".   di 4",
    "4",
    ".   error 459",
    "something that should be true of your data is not",
    "r(459);",
    ".   di 5",
    ".   if 1 {",
    ".     di 6",
    ".   }",
    ". }",
    ". di _rc",
    "459",
    ". cap noi {",
    ".   di 7",
    "7",
    ". }",
    ". di _rc",
    "0",
    ". noisily {",
    ".   di 8",
    "8",
    ". }",
    ". capture noisily {",
    ".   if 1 {",
    ".     error 198",
    "invalid syntax",
    "r(198);",
    ".   }",
    "r(198);",
    ".   di 9",
    ". }",
    ". di _rc",
    "198",
  ]);
  const stopped = transcript(
    "di 0\nif 1 {\n  di 1\n  error 198\n  di 9\n}\ndi 10\n",
  );
  assert.equal(stopped.rc, 198);
  assert.deepEqual(stopped.text, [
    ". di 0",
    "0",
    ". if 1 {",
    ".   di 1",
    "1",
    ".   error 198",
    "invalid syntax",
    "r(198);",
    ".   di 9",
    ". }",
    "r(198);",
  ]);
});

test("line-ending and prefix near-misses give Stata's messages", () => {
  // A /// on the last line continues into nothing.
  const dangling = transcript("di 1\ndi 2 ///\n");
  assert.equal(dangling.rc, 0);
  // Stata 19 echoes the line, and runs nothing.
  assert.deepEqual(dangling.text, [". di 1", "1", ". di 2 ///"]);
  const quiet = transcript(
    'quietly: foreach v in a b {\n  noisily di "`v\'"\n}\ndi "end"\n',
  );
  assert.equal(quiet.rc, 198);
  assert.ok(
    quiet.text.includes(
      "foreach command may not result from a macro expansion interactively or in do files",
    ),
  );
  const brace = transcript('clear\nset obs 2\ngen x=_n\nsum x {\ndi "after"\n');
  assert.equal(brace.rc, 198);
  assert.ok(brace.text.includes("nothing found where name expected"));
});

test("a numlist holds at most 2,500 numbers, outside graphs", () => {
  const session = new Session();
  let result = session.run("foreach i of numlist 1/100000 {\n}");
  assert.equal(result.rc, 123);
  result = session.run("foreach i of numlist 1 (1) 3 {\ndisplay `i'\n}");
  assert.deepEqual(
    result.output.flatMap((o) => o.lines),
    ["1", "2", "3"],
  );
  // Stata 19 draws xlabel(0(.01)20), 2,001 labels, without complaint;
  // the browser's own cap of 200 labels is what stops it.
  session.run("clear\nset obs 3\ngen x = _n\ngen y = x");
  const graph = session.run("scatter y x, xlabel(0(0.01)20)");
  assert.equal(graph.rc, 198);
  assert.match(graph.output.at(-1).lines.join(" "), /at most 200/);
});

test("old names of estat's tests and official commands the browser lacks", () => {
  const session = new Session();
  session.run(
    "clear\nset obs 30\nset seed 3\ngen x = runiform()\ngen y = x + runiform()\nquietly regress y x",
  );
  for (const [old, current] of [
    ["hettest", "estat hettest"],
    ["vif", "estat vif"],
    ["ovtest", "estat ovtest"],
  ])
    assert.deepEqual(
      session.run(old).output.at(-1).lines,
      session.run(current).output.at(-1).lines,
      old,
    );
  for (const name of [
    "intreg",
    "tsfill",
    "ipolate",
    "truncreg",
    "xtivreg",
    "postfile",
    "ksmirnov",
    "lroc",
    "pcorr",
    "frames",
    "predictnl",
    "linktest",
    "webuse",
    "mata",
  ]) {
    const result = session.run(`${name} y x`);
    assert.equal(result.rc, 199, name);
    assert.match(
      result.output.at(-1).lines[0],
      /is a Stata command that the browser does not run yet/,
      name,
    );
  }
});
