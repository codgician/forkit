"""Compile production keyboard_backlight.c with mocked hardware/hook dispatch.

Tests driver registration, cold-start behavior, and no PWM writes on sysjump.
Deferred callbacks run synchronously here; this does not test scheduler timing.
The identical test must fail with the sysjump registration hook removed.
"""
from pathlib import Path
import subprocess

root = Path.cwd()
repo = Path.cwd()
test = root / 'backlight-test'
test.mkdir(exist_ok=True)
headers = ['chipset.h', 'console.h', 'ec_commands.h', 'gpio.h', 'hooks.h',
           'host_command.h', 'keyboard_backlight.h', 'lid_switch.h',
           'rgb_keyboard.h', 'system.h', 'timer.h', 'util.h']
for name in headers:
    (test / name).write_text('#include "support.h"\n')
(test / 'keyboard_backlight-api.h').write_bytes((repo / 'include/keyboard_backlight.h').read_bytes())
(test / 'support.h').write_text(r'''
#ifndef TEST_SUPPORT_H
#define TEST_SUPPORT_H
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#define __overridable
#define __override_proto
#include "keyboard_backlight-api.h"
#define CONFIG_PWM_KBLIGHT 1
#define CONFIG_RGB_KEYBOARD 0
#define CONFIG_AP_POWER_CONTROL 1
#define CONFIG_LID_SWITCH 1
#define HAS_TASK_CHIPSET 1
#define IS_ENABLED(x) (x)
#define CHIPSET_STATE_ON 1
#define HOOK_PRIO_DEFAULT 5000
#define EC_SUCCESS 0
#define EC_ERROR_INVAL 1
#define EC_ERROR_UNIMPLEMENTED 2
#define EC_ERROR_PARAM1 3
#define CC_KEYBOARD 0
#define EC_VER_MASK(x) (1 << (x))
enum ec_status { EC_RES_SUCCESS = 0, EC_RES_ERROR = 2 };
struct host_cmd_handler_args { const void *params; void *response; int response_size; };
struct ec_params_pwm_set_keyboard_backlight { uint8_t percent; };
struct ec_response_pwm_get_keyboard_backlight { uint8_t percent; uint8_t enabled; };
struct deferred_data { void (*routine)(void); };
enum hook_kind { HOOK_INIT, HOOK_CHIPSET_STARTUP, HOOK_CHIPSET_SUSPEND,
                 HOOK_CHIPSET_RESUME, HOOK_LID_CHANGE, HOOK_COUNT };
static void (*registered_hooks[HOOK_COUNT])(void);
#define DECLARE_HOOK(kind, fn, priority) \
 static void __attribute__((constructor)) register_##fn(void) { registered_hooks[kind] = fn; }
#define DECLARE_DEFERRED(fn) static const struct deferred_data fn##_data = {fn}
#define DECLARE_HOST_COMMAND(...)
#define DECLARE_CONSOLE_COMMAND(...)
static void hook_call_deferred(const struct deferred_data *d, int delay) { (void)delay; d->routine(); }
static int cprints(int channel, const char *fmt, ...) { (void)channel; (void)fmt; return 0; }
static int cprintf(int channel, const char *fmt, ...) { (void)channel; (void)fmt; return 0; }
#define ccprintf printf
#define strtoi strtol
static int jumped, awake, lid_open = 1;
static int system_jumped_to_this_image(void) { return jumped; }
static int chipset_in_state(int mask) { return awake && (mask & CHIPSET_STATE_ON); }
static int lid_is_open(void) { return lid_open; }
extern const struct kblight_drv kblight_rgbkbd;
#endif
''')
(test / 'test.c').write_text(r'''
#include "support.h"
#include EC_SOURCE
static int init_calls, set_calls, enable_calls, hw_percent, hw_enabled;
static int mock_init(void) { ++init_calls; hw_percent=0; hw_enabled=0; return 0; }
static int mock_set(int p) { ++set_calls; hw_percent=p; return 0; }
static int mock_enable(int e) { ++enable_calls; hw_enabled=e; return 0; }
static int mock_get(void) { return hw_enabled; }
const struct kblight_drv kblight_pwm = {mock_init, mock_set, mock_enable, mock_get};
const struct kblight_drv kblight_rgbkbd = {mock_init, mock_set, mock_enable, mock_get};
#define CHECK(c) do { if (!(c)) { fprintf(stderr,"FAIL line %d: %s\n",__LINE__,#c); exit(1); } } while(0)
static void reset(void) {
 kblight.drv=NULL; current_percent=0; current_enable=0;
 init_calls=set_calls=enable_calls=0; hw_percent=42; hw_enabled=1;
}
static void notify(enum hook_kind h) { if (registered_hooks[h]) registered_hooks[h](); }
int main(void) {
 reset(); jumped=1; awake=1;
 notify(HOOK_INIT);
 CHECK(kblight.drv == &kblight_pwm);
 CHECK(init_calls == 0 && set_calls == 0 && enable_calls == 0);
 CHECK(hw_percent == 42 && hw_enabled == 1);
 puts("PASS: S0 sysjump registers PWM driver without resetting hardware");
 struct ec_params_pwm_set_keyboard_backlight p={73};
 struct host_cmd_handler_args args={.params=&p};
 CHECK(hc_set_keyboard_backlight(&args)==EC_RES_SUCCESS);
 CHECK(hw_percent==73 && hw_enabled==1 && set_calls==1 && enable_calls==1);
 struct ec_response_pwm_get_keyboard_backlight response={0};
 args.response=&response;
 CHECK(hc_get_keyboard_backlight(&args)==EC_RES_SUCCESS);
 CHECK(response.percent==73 && response.enabled==1);
 puts("PASS: host set/get commands reach the driver after sysjump");
 p.percent=0;
 CHECK(hc_set_keyboard_backlight(&args)==EC_RES_SUCCESS);
 CHECK(hw_percent==0 && hw_enabled==0);
 p.percent=101;
 CHECK(hc_set_keyboard_backlight(&args)==EC_RES_ERROR);
 puts("PASS: off and invalid-brightness requests retain expected behavior");
 reset(); jumped=0; awake=1;
 notify(HOOK_INIT);
 CHECK(kblight.drv==NULL && init_calls==0 && set_calls==0 && enable_calls==0);
 puts("PASS: cold boot is not treated as sysjump");
 notify(HOOK_CHIPSET_STARTUP);
 CHECK(kblight.drv==&kblight_pwm && init_calls==1 && hw_enabled==0);
 puts("PASS: ordinary chipset startup still initializes and disables PWM");
 reset(); jumped=1; awake=0;
 notify(HOOK_INIT);
 CHECK(kblight.drv==NULL && init_calls==0 && set_calls==0 && enable_calls==0);
 notify(HOOK_CHIPSET_STARTUP);
 CHECK(kblight.drv==&kblight_pwm && init_calls==1);
 puts("PASS: non-S0 jump retains ordinary startup path");
 return 0;
}
''')
gcc = 'gcc'
upstream = test / 'keyboard_backlight-upstream.c'
source = (repo / 'common/keyboard_backlight.c').read_text()
hook = 'DECLARE_HOOK(HOOK_INIT, keyboard_backlight_sysjump_init, HOOK_PRIO_DEFAULT);'
assert source.count(hook) == 1
upstream.write_text(source.replace(hook, '/* Negative control: no sysjump registration hook. */'))
for name, source, expected in [
    ('patched', repo / 'common/keyboard_backlight.c', 0),
    ('upstream', upstream, 1),
]:
    exe = test / name
    subprocess.run([gcc, '-std=gnu11', '-Wall', '-Wextra', '-Werror',
                    '-Wno-unused-function', '-I' + str(test),
                    '-DEC_SOURCE="' + str(source) + '"', str(test / 'test.c'),
                    '-o', str(exe)], check=True)
    result = subprocess.run([str(exe)], text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT)
    print(name + ':\n' + result.stdout, flush=True)
    assert result.returncode == expected, (name, result.returncode)
print('PASS: patched production source passes; negative control reproduces missing registration')
