/**
 * Unit tests for the shared profile item_state builder.
 *
 * The phone rule is the part with a consequence: the profile phone is always the
 * cleaned E.164 number, whatever form was typed.
 */
import { describe, it, expect } from 'vitest';
import { buildSignalStackItemState } from '../item-state.js';

describe('buildSignalStackItemState', () => {
  it('replaces a typed phone with the cleaned E.164 number', () => {
    for (const typed of ['9876543210', '+91 98765 43210', '09876543210']) {
      expect(
        buildSignalStackItemState(
          { name: 'Asha', mobile_number: typed },
          '+919876543210',
          'mobile_number',
        ),
      ).toEqual({ name: 'Asha', mobile_number: '+919876543210' });
    }
  });

  it('fills the phone field from the normalised phone when the body has none', () => {
    expect(buildSignalStackItemState({ name: 'Asha' }, '+919876543210', 'mobile_number')).toEqual({
      name: 'Asha',
      mobile_number: '+919876543210',
    });
  });

  it('treats an empty phone cell as missing', () => {
    expect(
      buildSignalStackItemState({ mobile_number: '' }, '+919876543210', 'mobile_number'),
    ).toEqual({ mobile_number: '+919876543210' });
  });

  it('leaves the phone field alone when there is no cleaned phone', () => {
    expect(buildSignalStackItemState({ name: 'Asha' }, null, 'mobile_number')).toEqual({
      name: 'Asha',
    });
  });

  it('does not mutate the body', () => {
    const body = { name: 'Asha', mobile_number: '9876543210' };
    buildSignalStackItemState(body, '+919876543210', 'mobile_number');
    expect(body).toEqual({ name: 'Asha', mobile_number: '9876543210' });
  });
});
